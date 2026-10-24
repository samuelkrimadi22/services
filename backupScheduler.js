// services/backupScheduler.js
// V9.6.0: Backup otomatis via node-cron (tanpa Task Scheduler)

const cron = require('node-cron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = path.join(__dirname, '..');
const BACKUP_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'backup-db.js');
const LOG_FILE = path.join(PROJECT_DIR, 'backups', 'scheduler.log');

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(`💾 [BackupScheduler] ${msg}`);
    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (e) {
        console.error('[BackupScheduler] Log error:', e.message);
    }
}

function runBackup() {
    log('Backup starting...');
    const startTime = Date.now();
    
    exec(`node "${BACKUP_SCRIPT}"`, {
            windowsHide: true, // V9.6.0
        cwd: PROJECT_DIR,
        maxBuffer: 50 * 1024 * 1024
    }, (error, stdout, stderr) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (error) {
            log(`❌ Backup FAILED (${elapsed}s): ${error.message}`);
            if (stderr) log(`   stderr: ${stderr.slice(0, 500)}`);
            return;
        }
        
        log(`✅ Backup OK (${elapsed}s)`);
        if (stdout) {
            const lines = stdout.split('\n').filter(l => l.trim()).slice(-3);
            lines.forEach(l => log(`   ${l}`));
        }
    });
}

function start() {
    // Cek script backup ada
    if (!fs.existsSync(BACKUP_SCRIPT)) {
        log('⚠️  backup-db.js NOT found — scheduler OFF');
        return;
    }

    // Jadwal: Setiap hari jam 03:00 pagi
    // Format cron: menit jam hari-bulan bulan hari-minggu
    cron.schedule('0 3 * * *', () => {
        log('⏰ Triggered by cron (jam 3 pagi)');
        runBackup();
    }, {
        timezone: "Asia/Jakarta"
    });

    log('🚀 Backup scheduler active — jalan tiap hari jam 03:00 WIB');
    
    // Optional: Test run 1 menit setelah server start (untuk verify)
    // Comment kalau tidak mau:
    // setTimeout(() => {
    //     log('🧪 Test run (1 menit setelah start)');
    //     runBackup();
    // }, 60 * 1000);
}

module.exports = { start, runBackup };