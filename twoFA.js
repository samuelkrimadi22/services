// services/twoFA.js
// Service untuk 2FA (TOTP) — V9.7.0
// Menggunakan library: speakeasy, qrcode, bcryptjs

const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const { dbRun, dbGet } = require("../database/db");

const APP_NAME = process.env.APP_NAME || "Clipora";

// ============================================================
// GENERATE SECRET + QR CODE
// ============================================================
async function generateSecret(user) {
    // Buat secret base32
    const secret = speakeasy.generateSecret({
        name: `${APP_NAME} (${user.email})`,
        issuer: APP_NAME,
        length: 32,
    });

    // Generate QR code sebagai data URL (base64 PNG)
    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);

    return {
        secret: secret.base32,         // Simpan ke DB
        otpauth_url: secret.otpauth_url,
        qr_code: qrDataUrl,            // Kirim ke frontend
    };
}

// ============================================================
// VERIFY TOKEN (6-digit TOTP)
// ============================================================
function verifyToken(secret, token) {
    if (!secret || !token) return false;
    try {
        return speakeasy.totp.verify({
            secret: secret,
            encoding: "base32",
            token: String(token).trim(),
            window: 1,  // Toleransi ±30 detik
        });
    } catch (e) {
        console.error("[2FA] verifyToken error:", e.message);
        return false;
    }
}

// ============================================================
// GENERATE BACKUP CODES
// ============================================================
async function generateBackupCodes(count = 10) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        // Format: XXXX-XXXX (8 karakter, split 4-4)
        const raw = require("crypto").randomBytes(4).toString("hex").toUpperCase();
        const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
        codes.push(code);
    }

    // Hash semua codes sebelum simpan
    const hashed = await Promise.all(
        codes.map(c => bcrypt.hash(c, 10))
    );

    return {
        plainCodes: codes,                 // Tampilkan ke user SEKALI
        hashedCodes: JSON.stringify(hashed), // Simpan ke DB
    };
}

// ============================================================
// VERIFY BACKUP CODE
// ============================================================
async function verifyBackupCode(userId, code) {
    const user = await dbGet(
        `SELECT two_fa_backup_codes FROM public.users WHERE id = $1`,
        [userId]
    );
    if (!user || !user.two_fa_backup_codes) return false;

    let hashedCodes;
    try {
        hashedCodes = JSON.parse(user.two_fa_backup_codes);
    } catch (e) {
        return false;
    }

    const cleanCode = String(code).trim().toUpperCase();

    // Cek satu per satu
    for (let i = 0; i < hashedCodes.length; i++) {
        const match = await bcrypt.compare(cleanCode, hashedCodes[i]);
        if (match) {
            // Hapus kode yang sudah dipakai (one-time use)
            hashedCodes.splice(i, 1);
            await dbRun(
                `UPDATE public.users SET two_fa_backup_codes = $1 WHERE id = $2`,
                [JSON.stringify(hashedCodes), userId]
            );
            return true;
        }
    }

    return false;
}

// ============================================================
// ENABLE 2FA (setelah user verify setup)
// ============================================================
async function enable2FA(userId, secret, token) {
    if (!verifyToken(secret, token)) {
        return { success: false, error: "Kode verifikasi salah" };
    }

    // Generate backup codes
    const { plainCodes, hashedCodes } = await generateBackupCodes(10);

    // Simpan ke DB
    await dbRun(
        `UPDATE public.users 
         SET two_fa_secret = $1, 
             two_fa_enabled = TRUE, 
             two_fa_backup_codes = $2,
             two_fa_enabled_at = NOW()
         WHERE id = $3`,
        [secret, hashedCodes, userId]
    );

    return {
        success: true,
        backupCodes: plainCodes,  // Tampilkan SEKALI ke user
    };
}

// ============================================================
// DISABLE 2FA
// ============================================================
async function disable2FA(userId, token, password) {
    const user = await dbGet(
        `SELECT two_fa_secret, password_hash FROM public.users WHERE id = $1`,
        [userId]
    );
    if (!user) return { success: false, error: "User tidak ditemukan" };

    // Verify token
    if (!verifyToken(user.two_fa_secret, token)) {
        return { success: false, error: "Kode 2FA salah" };
    }

    // Verify password (extra layer)
    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
        return { success: false, error: "Password salah" };
    }

    await dbRun(
        `UPDATE public.users 
         SET two_fa_secret = NULL, 
             two_fa_enabled = FALSE, 
             two_fa_backup_codes = NULL,
             two_fa_enabled_at = NULL
         WHERE id = $1`,
        [userId]
    );

    return { success: true };
}

// ============================================================
// GET STATUS
// ============================================================
async function getStatus(userId) {
    const user = await dbGet(
        `SELECT two_fa_enabled, two_fa_enabled_at 
         FROM public.users WHERE id = $1`,
        [userId]
    );
    if (!user) return { enabled: false };
    return {
        enabled: user.two_fa_enabled === true,
        enabledAt: user.two_fa_enabled_at,
    };
}

// ============================================================
// CHECK USER NEEDS 2FA (saat login)
// ============================================================
async function checkUserNeeds2FA(userId) {
    const user = await dbGet(
        `SELECT two_fa_enabled, is_admin FROM public.users WHERE id = $1`,
        [userId]
    );
    if (!user) return false;
    return user.two_fa_enabled === true;
}

module.exports = {
    generateSecret,
    verifyToken,
    generateBackupCodes,
    verifyBackupCode,
    enable2FA,
    disable2FA,
    getStatus,
    checkUserNeeds2FA,
};
