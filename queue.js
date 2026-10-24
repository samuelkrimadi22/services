// services/queue.js - Job Queue System (V8.7.0 - Anti Stuck)
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join(__dirname, '..', 'queue_state.json');

// ============================================================
// KONFIGURASI ANTI-STUCK
// ============================================================
const MAX_JOB_AGE_HOURS = parseInt(process.env.MAX_JOB_AGE_HOURS) || 2;   // Job > 2 jam = expired
const STUCK_TIMEOUT_MIN = parseInt(process.env.STUCK_TIMEOUT_MIN) || 30;  // Job processing > 30 menit = stuck

class JobQueue extends EventEmitter {
    constructor(options = {}) {
        super();
        this.jobs = new Map();
        this.pending = [];
        this.processing = new Set();
        this.maxConcurrent = options.maxConcurrent || 1;
        this.maxRetries = options.maxRetries || 2;
        this.stats = {
            total: 0,
            completed: 0,
            failed: 0,
            processing: 0
        };

        // Map untuk track waktu mulai processing (watchdog)
        this.processingStartTime = new Map();

        // Load queue dari file kalau ada
        this._loadFromDisk();

        // Start watchdog (cek job stuck tiap 2 menit)
        this._startWatchdog();
    }

    // ============================================================
    // PERSISTENCE
    // ============================================================
    _saveToDisk() {
        try {
            // V8.9.22: Auto-cleanup sebelum save — buang job failed lama & completed lama
            const now = Date.now();
            const FAILED_MAX_AGE_MS = 6 * 60 * 60 * 1000;      // failed > 6 jam → buang
            const COMPLETED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // completed > 7 hari → buang
            const MAX_JOBS_IN_FILE = 100;                       // cap total job di file

            // Filter job yang layak disimpan
            const jobsToKeep = [];
            for (const [id, job] of this.jobs) {
                // Skip job yang sudah dihapus dari map
                if (!this.jobs.has(id)) continue;

                const age = now - new Date(job.finishedAt || job.createdAt || 0).getTime();

                // Failed > 6 jam → skip
                if (job.status === 'failed' && age > FAILED_MAX_AGE_MS) continue;

                // Completed > 7 hari → skip
                if (job.status === 'completed' && age > COMPLETED_MAX_AGE_MS) continue;

                // Cancelled → skip langsung (tidak perlu disimpan)
                if (job.status === 'cancelled') continue;

                jobsToKeep.push([id, job]);
            }

            // Sort by createdAt desc, ambil N terbaru
            jobsToKeep.sort((a, b) =>
                new Date(b[1].createdAt) - new Date(a[1].createdAt)
            );
            const trimmed = jobsToKeep.slice(0, MAX_JOBS_IN_FILE);

            const data = {
                jobs: trimmed.map(([id, job]) => ({
                    ...job,
                    data: job.data
                })),
                pending: this.pending,
                savedAt: new Date().toISOString()
            };
            fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2));

            // Info kalau ada yang dibuang
            if (trimmed.length < this.jobs.size) {
                const removed = this.jobs.size - trimmed.length;
                console.log(`[Queue] 🗑️  Auto-cleanup: ${removed} job lama dibuang dari disk`);
            }
        } catch (e) {
            console.error('[Queue] Save error:', e.message);
        }
    }

    // ============================================================
    // FIXED: Load from disk — TIDAK restore job lama & stuck
    // ============================================================
    _loadFromDisk() {
        try {
            if (!fs.existsSync(QUEUE_FILE)) return;

            const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
            console.log(`[Queue] Load ${data.jobs?.length || 0} job dari disk`);

            const now = Date.now();
            const maxAgeMs = MAX_JOB_AGE_HOURS * 60 * 60 * 1000;
            let restoredCount = 0;
            let expiredCount = 0;

            for (const job of (data.jobs || [])) {
                // ============================================================
                // CEK 1: Job TERLALU TUA → langsung FAIL, jangan diproses
                // ============================================================
                const created = new Date(job.createdAt).getTime();
                const ageMs = now - created;

                if (ageMs > maxAgeMs) {
                    job.status = 'failed';
                    job.error = `Expired (job > ${MAX_JOB_AGE_HOURS} jam dari restart)`;
                    job.finishedAt = new Date().toISOString();
                    console.log(`[Queue] Job ${job.id} EXPIRED (${Math.round(ageMs/3600000)} jam) — SKIP`);
                    expiredCount++;
                    this.jobs.set(job.id, job);
                    continue;
                }

                // ============================================================
                // CEK 2: Job status 'processing' → tandai FAILED (jangan restore!)
                // Ini yang bikin stuck! Job lama yang stuck karena restart,
                // kalau di-restore akan blokir user baru karena max_concurrent=1.
                // ============================================================
                if (job.status === 'processing') {
                    job.status = 'failed';
                    job.error = 'Server restart saat memproses (incomplete)';
                    job.finishedAt = new Date().toISOString();
                    job.progress = 0;
                    console.log(`[Queue] Job ${job.id} sebelumnya PROCESSING → ditandai FAILED (tidak di-restore)`);
                    this.jobs.set(job.id, job);
                    continue;
                }

                // ============================================================
                // CEK 3: Job status 'queued' → restore (hanya kalau masih fresh)
                // ============================================================
                if (job.status === 'queued') {
                    // Cek file input masih ada
                    const inputPath = job.data?.inputPath;
                    if (inputPath && !fs.existsSync(inputPath)) {
                        job.status = 'failed';
                        job.error = 'File input sudah dihapus';
                        job.finishedAt = new Date().toISOString();
                        console.log(`[Queue] Job ${job.id} → FAILED (file input hilang)`);
                        this.jobs.set(job.id, job);
                        continue;
                    }
                    // Restore ke pending
                    console.log(`[Queue] Job ${job.id} di-restore ke queue (fresh)`);
                    restoredCount++;
                }

                this.jobs.set(job.id, job);
            }

            // Rebuild pending dari job yang status 'queued'
            this.pending = [];
            for (const [id, job] of this.jobs) {
                if (job.status === 'queued') {
                    this.pending.push(id);
                }
            }

            this.pending.sort((a, b) => this.jobs.get(a).priority - this.jobs.get(b).priority);

            // Rebuild stats
            for (const job of this.jobs.values()) {
                this.stats.total++;
                if (job.status === 'completed') this.stats.completed++;
                if (job.status === 'failed') this.stats.failed++;
            }

            console.log(`[Queue] Pending: ${this.pending.length} job (restored: ${restoredCount}, expired: ${expiredCount})`);

            // ✅ FIXED: Auto-start job restored (hanya yang fresh & valid)
            if (this.pending.length > 0) {
                console.log(`[Queue] Auto-start ${this.pending.length} job (fresh)...`);
                setTimeout(() => this._processNext(), 2000);
            } else {
                console.log(`[Queue] Tidak ada job valid untuk di-restore`);
            }
        } catch (e) {
            console.error('[Queue] Load error:', e.message);
        }
    }

    // ============================================================
    // WATCHDOG — Cek job stuck tiap 2 menit
    // ============================================================
    _startWatchdog() {
        setInterval(() => {
            const now = Date.now();
            for (const jobId of this.processing) {
                const startTime = this.processingStartTime.get(jobId);
                if (!startTime) continue;

                const elapsedMin = (now - startTime) / 60000;

                // Job processing > STUCK_TIMEOUT_MIN → anggap stuck
                if (elapsedMin > STUCK_TIMEOUT_MIN) {
                    const job = this.jobs.get(jobId);
                    if (job) {
                        console.warn(`[Queue] ⚠️  Job ${jobId} STUCK ${Math.round(elapsedMin)} menit — ditandai FAILED`);
                        job.status = 'failed';
                        job.error = `Stuck (${Math.round(elapsedMin)} menit tanpa progress)`;
                        job.finishedAt = new Date().toISOString();
                        this.processing.delete(jobId);
                        this.processingStartTime.delete(jobId);
                        this.stats.processing--;
                        this.stats.failed++;
                        this.emit('job:failed', job);
                        this._saveToDisk();
                    }
                }
            }
        }, 2 * 60 * 1000); // Cek tiap 2 menit
    }

    add(data, options = {}) {
        const jobId = uuidv4();
        const job = {
            id: jobId,
            userId: options.userId || null,
            data,
            priority: options.priority || 5,
            maxRetries: options.maxRetries || this.maxRetries,
            retries: 0,
            status: 'queued',
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            result: null,
            error: null,
            progress: 0,
            message: 'Menunggu antrian...'
        };

        this.jobs.set(jobId, job);
        this.pending.push(jobId);
        this.pending.sort((a, b) => this.jobs.get(a).priority - this.jobs.get(b).priority);
        this.stats.total++;

        this._saveToDisk();
        this.emit('job:added', job);
        console.log(`[Queue] Job ditambahkan: ${jobId} (priority ${job.priority})`);

        this._processNext();
        return jobId;
    }

    _processNext() {
        if (this.processing.size >= this.maxConcurrent) return;
        if (this.pending.length === 0) return;

        const jobId = this.pending.shift();
        const job = this.jobs.get(jobId);
        if (!job) return;

        job.status = 'processing';
        job.startedAt = new Date().toISOString();
        this.processing.add(jobId);
        this.processingStartTime.set(jobId, Date.now());  // ← Track waktu mulai
        this.stats.processing++;

        this._saveToDisk();
        this.emit('job:started', job);
        console.log(`[Queue] Memproses job: ${jobId}`);

        const done = (result) => {
            job.status = 'completed';
            job.finishedAt = new Date().toISOString();
            job.result = result;
            this.processing.delete(jobId);
            this.processingStartTime.delete(jobId);
            this.stats.processing--;
            this.stats.completed++;
            this._saveToDisk();
            this.emit('job:completed', job);
            console.log(`[Queue] Job selesai: ${jobId}`);
            this._processNext();
        };

        const fail = (error) => {
            job.retries++;
            if (job.retries < job.maxRetries) {
                job.status = 'queued';
                job.error = error;
                this.pending.push(jobId);
                this.pending.sort((a, b) => this.jobs.get(a).priority - this.jobs.get(b).priority);
                console.log(`[Queue] Job retry ${job.retries}/${job.maxRetries}: ${jobId}`);
                this.emit('job:retry', job);
            } else {
                job.status = 'failed';
                job.finishedAt = new Date().toISOString();
                job.error = error;
                this.stats.failed++;
                this.emit('job:failed', job);
                console.log(`[Queue] Job gagal: ${jobId} - ${error}`);
            }
            this.processing.delete(jobId);
            this.processingStartTime.delete(jobId);
            this.stats.processing--;
            this._saveToDisk();
            this._processNext();
        };

        const updateProgress = (progress, message = '') => {
            job.progress = progress;
            job.message = message;
            this.emit('job:progress', job);
        };

        this.emit('job:ready', job, { done, fail, updateProgress });
    }

    getJob(jobId) {
        return this.jobs.get(jobId);
    }

    getJobs(filter = {}) {
        let jobs = Array.from(this.jobs.values());
        if (filter.userId) jobs = jobs.filter(j => j.userId === filter.userId);
        if (filter.status) jobs = jobs.filter(j => j.status === filter.status);
        return jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    cancel(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return false;
        if (job.status !== 'queued') return false;
        job.status = 'cancelled';
        this.pending = this.pending.filter(id => id !== jobId);
        this._saveToDisk();
        this.emit('job:cancelled', job);
        return true;
    }

    // Force cancel job apapun (termasuk processing)
    forceCancel(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return false;
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        this.pending = this.pending.filter(id => id !== jobId);
        if (this.processing.has(jobId)) {
            this.processing.delete(jobId);
            this.processingStartTime.delete(jobId);
            this.stats.processing--;
        }
        this._saveToDisk();
        this.emit('job:cancelled', job);
        console.log(`[Queue] Job ${jobId} FORCE CANCELLED`);
        this._processNext();
        return true;
    }

    // Hapus semua job pending (untuk emergency)
    clearPending() {
        const count = this.pending.length;
        for (const id of this.pending) {
            const job = this.jobs.get(id);
            if (job) {
                job.status = 'cancelled';
                job.finishedAt = new Date().toISOString();
            }
        }
        this.pending = [];
        this._saveToDisk();
        console.log(`[Queue] Cleared ${count} pending jobs`);
        return count;
    }

    getStats() {
        return {
            ...this.stats,
            pending: this.pending.length,
            processing: this.processing.size
        };
    }

    cleanup(maxAgeHours = 24) {
        const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
        let cleaned = 0;
        for (const [id, job] of this.jobs) {
            if (job.finishedAt && new Date(job.finishedAt).getTime() < cutoff) {
                this.jobs.delete(id);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this._saveToDisk();
            console.log(`[Queue] Cleanup ${cleaned} job lama`);
        }
        return cleaned;
    }
}

// Konfigurasi
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT) || 1;
const queue = new JobQueue({ maxConcurrent: MAX_CONCURRENT, maxRetries: 2 });

console.log(`[Queue] Max concurrent: ${MAX_CONCURRENT}`);
console.log(`[Queue] Max job age: ${MAX_JOB_AGE_HOURS} jam (job lebih tua akan di-skip)`);
console.log(`[Queue] Stuck timeout: ${STUCK_TIMEOUT_MIN} menit`);

// Auto-cleanup setiap jam
setInterval(() => queue.cleanup(24), 3600 * 1000);

module.exports = queue;