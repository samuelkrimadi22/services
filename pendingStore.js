// services/pendingStore.js — V8.9.21
// Persistent pending analyses: ganti Map() dengan disk-backed store.
// API sama dengan Map supaya drop-in replacement.
const fs = require('fs');
const path = require('path');

const PENDING_DIR = path.join(__dirname, '..', 'temp', 'pending');
const TTL_MS = 60 * 60 * 1000; // 1 jam (sama dengan PENDING_TTL_MS di server.js)

// Pastikan folder ada
if (!fs.existsSync(PENDING_DIR)) {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    console.log(`📁 [PendingStore] Created ${PENDING_DIR}`);
}

// In-memory cache (biar GET cepat)
const _cache = new Map();


// ============================================================
// Helper: validasi ID (cegah path traversal)
// ============================================================
function _isValidId(id) {
    if (typeof id !== 'string') return false;
    // V8.9.21-fix: HANYA UUID format (cegah analysis_*.json masuk)
    // Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (36 char)
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}


function _filePath(id) {
    return path.join(PENDING_DIR, `${id}.json`);
}

// ============================================================
// Atomic write: tulis ke .tmp, lalu rename
// ============================================================
function _atomicWrite(filePath, data) {
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (e) {
        console.error(`❌ [PendingStore] Write error: ${e.message}`);
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        return false;
    }
}

// ============================================================
// LOAD ALL — dipanggil saat startup
// ============================================================
function loadAll() {
    if (!fs.existsSync(PENDING_DIR)) return 0;

    let loaded = 0;
    let expired = 0;
    let corrupted = 0;

    try {
        const files = fs.readdirSync(PENDING_DIR);
        for (const fname of files) {
            if (!fname.endsWith('.json')) continue;
            if (fname.includes('.tmp.')) continue;

            const id = fname.replace(/\.json$/, '');
            if (!_isValidId(id)) continue;

            const fpath = path.join(PENDING_DIR, fname);
            try {
                const raw = fs.readFileSync(fpath, 'utf8');
                const data = JSON.parse(raw);

                // Skip kalau sudah lewat TTL
                if (data.createdAt && (Date.now() - data.createdAt > TTL_MS)) {
                    try { fs.unlinkSync(fpath); } catch (_) {}
                    expired++;
                    continue;
                }

                _cache.set(id, data);
                loaded++;
            } catch (e) {
                console.warn(`⚠️ [PendingStore] Corrupt file ${fname}: ${e.message}`);
                try { fs.unlinkSync(fpath); } catch (_) {}
                corrupted++;
            }
        }

        console.log(`📦 [PendingStore] Loaded: ${loaded} valid, ${expired} expired, ${corrupted} corrupt`);
    } catch (e) {
        console.error(`❌ [PendingStore] loadAll error: ${e.message}`);
    }

    return loaded;
}


// ============================================================
// MAP-COMPATIBLE API
// ============================================================
function set(id, data) {
    if (!_isValidId(id)) {
        console.warn(`⚠️ [PendingStore] Invalid ID: ${id}`);
        return false;
    }

    // Simpan ke memory
    _cache.set(id, data);

    // Tulis ke disk
    const fpath = _filePath(id);
    const ok = _atomicWrite(fpath, data);
    if (ok) {
        console.log(`💾 [PendingStore] Persisted ${id.slice(0, 8)} (${data.isAutoClip ? 'auto-clip' : 'full'})`);
    }
    return ok;
}

function get(id) {
    if (!_isValidId(id)) return undefined;

    // Cache hit
    if (_cache.has(id)) {
        return _cache.get(id);
    }

    // Fallback: baca dari file (kalau cache miss)
    const fpath = _filePath(id);
    if (fs.existsSync(fpath)) {
        try {
            const raw = fs.readFileSync(fpath, 'utf8');
            const data = JSON.parse(raw);
            _cache.set(id, data);
            return data;
        } catch (e) {
            console.warn(`⚠️ [PendingStore] Read error ${id.slice(0, 8)}: ${e.message}`);
        }
    }

    return undefined;
}

function has(id) {
    if (_cache.has(id)) return true;
    return fs.existsSync(_filePath(id));
}

function deleteEntry(id) {
    if (!_isValidId(id)) return false;

    const had = _cache.delete(id);
    const fpath = _filePath(id);
    let fileDeleted = false;

    try {
        if (fs.existsSync(fpath)) {
            fs.unlinkSync(fpath);
            fileDeleted = true;
        }
    } catch (e) {
        console.warn(`⚠️ [PendingStore] Delete file error ${id.slice(0, 8)}: ${e.message}`);
    }

    if (had || fileDeleted) {
        console.log(`🗑️  [PendingStore] Removed ${id.slice(0, 8)}`);
    }

    return had || fileDeleted;
}

function entries() {
    // Return array of [id, data] — untuk loop cleanup TTL di server.js
    return Array.from(_cache.entries());
}

function keys() {
    return Array.from(_cache.keys());
}

function values() {
    return Array.from(_cache.values());
}

function clear() {
    const ids = Array.from(_cache.keys());
    for (const id of ids) {
        deleteEntry(id);
    }
    return ids.length;
}


// ============================================================
// EXPORT — API mirip Map
// ============================================================
module.exports = {
    // Map-like API
    set,
    get,
    has,
    delete: deleteEntry,
    entries,
    keys,
    values,
    clear,

    // Property getter (biar `pendingAnalyses.size` jalan seperti Map)
    get size() { return _cache.size; },

    // Custom
    loadAll,
    PENDING_DIR,
};