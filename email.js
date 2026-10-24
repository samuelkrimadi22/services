// services/email.js — V9.8.0
const nodemailer = require("nodemailer");

const APP_NAME = process.env.APP_NAME || "Clipora";
const APP_URL = process.env.APP_URL || "https://localhost/clipora";

let _transporter = null;

function getTransporter() {
    if (_transporter) return _transporter;
    const host = process.env.SMTP_HOST || "smtp.gmail.com";
    const port = parseInt(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!user || !pass) {
        console.warn("⚠️  [Email] SMTP credentials tidak di-set di .env");
        return null;
    }
    _transporter = nodemailer.createTransport({
        host, port,
        secure: port === 465,
        auth: { user, pass },
        tls: { rejectUnauthorized: false },
    });
    console.log(`📧 [Email] Transporter initialized (${host}:${port})`);
    return _transporter;
}

async function sendEmail({ to, subject, html, text }) {
    const transporter = getTransporter();
    if (!transporter) throw new Error("SMTP tidak dikonfigurasi");
    const from = process.env.SMTP_FROM || '"' + APP_NAME + '" <' + process.env.SMTP_USER + '>';
    try {
        const info = await transporter.sendMail({
            from, to, subject, html,
            text: text || html.replace(/<[^>]+>/g, ""),
        });
        console.log(`✅ [Email] Sent to ${to}: ${subject}`);
        return { success: true, messageId: info.messageId };
    } catch (e) {
        console.error(`❌ [Email] Failed to ${to}:`, e.message);
        return { success: false, error: e.message };
    }
}

async function sendWelcomeEmail({ to, username, fullName }) {
    const name = fullName || username;
    const subject = `🎉 Selamat Datang di ${APP_NAME}!`;
    const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;margin:0">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
<div style="background:linear-gradient(135deg,#f59e0b,#8b5cf6);color:#fff;padding:40px;text-align:center">
<h1 style="margin:0">🎬 ${APP_NAME}</h1><p style="margin:8px 0 0;opacity:0.9">AI Video Editor Otomatis</p>
</div>
<div style="padding:40px">
<h2 style="color:#1a1a2e">Halo ${name}! 👋</h2>
<p>Terima kasih sudah mendaftar di <strong>${APP_NAME}</strong>.</p>
<p>Akun Anda sudah aktif dan siap digunakan!</p>
<div style="background:#f9f9f9;border-radius:10px;padding:20px;margin:20px 0">
<strong>Yang bisa Anda lakukan:</strong>
<ul style="margin:10px 0;padding-left:20px">
<li>✂️ Auto-cut jeda & kata tidak penting</li>
<li>💬 Subtitle otomatis dengan AI</li>
<li>🎙️ Voice over AI</li>
<li>🌍 Translate subtitle multi-bahasa</li>
</ul></div>
<div style="text-align:center">
<a href="${APP_URL}/dashboard.php" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#f59e0b,#8b5cf6);color:#fff;text-decoration:none;border-radius:50px;font-weight:700">🚀 Mulai Sekarang</a>
</div></div>
<div style="background:#f9f9f9;padding:20px;text-align:center;color:#888;font-size:12px">
© ${new Date().getFullYear()} ${APP_NAME}
</div></div></body></html>`;
    return sendEmail({ to, subject, html });
}

async function sendPasswordResetEmail({ to, username, resetLink, expiresIn }) {
    expiresIn = expiresIn || "1 jam";
    const subject = `🔒 Reset Password ${APP_NAME}`;
    const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;margin:0">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
<div style="background:linear-gradient(135deg,#ef4444,#f59e0b);color:#fff;padding:40px;text-align:center">
<h1 style="margin:0">🔒 Reset Password</h1>
</div>
<div style="padding:40px">
<h2 style="color:#1a1a2e">Halo ${username},</h2>
<p>Kami menerima permintaan reset password akun Anda.</p>
<div style="text-align:center;margin:30px 0">
<a href="${resetLink}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#ef4444,#f59e0b);color:#fff;text-decoration:none;border-radius:50px;font-weight:700">🔓 Reset Password</a>
</div>
<div style="background:#fff5f5;border-left:4px solid #ef4444;padding:12px 16px;border-radius:6px;font-size:13px;color:#b91c1c">
⚠️ Link ini kadaluarsa dalam <strong>${expiresIn}</strong>.<br>
Kalau Anda tidak meminta reset, abaikan email ini.
</div></div>
<div style="background:#f9f9f9;padding:20px;text-align:center;color:#888;font-size:12px">
© ${new Date().getFullYear()} ${APP_NAME}
</div></div></body></html>`;
    return sendEmail({ to, subject, html });
}

async function sendReceiptEmail({ to, username, orderId, plan, amount, method, date }) {
    const subject = `💳 Pembayaran Berhasil — ${APP_NAME}`;
    const fmt = (n) => "Rp " + Number(n).toLocaleString("id-ID");
    const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;margin:0">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
<div style="background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;padding:40px;text-align:center">
<h1 style="margin:0">💳 Pembayaran Berhasil</h1>
</div>
<div style="padding:40px">
<h2 style="color:#1a1a2e">Halo ${username},</h2>
<p>Terima kasih! Pembayaran Anda sudah kami terima.</p>
<div style="background:#f9f9f9;border-radius:10px;padding:20px;margin:20px 0">
<div style="padding:10px 0;border-bottom:1px solid #eee"><span>Order ID: ${orderId}</span></div>
<div style="padding:10px 0;border-bottom:1px solid #eee"><span>Paket: ${plan}</span></div>
<div style="padding:10px 0;border-bottom:1px solid #eee"><span>Metode: ${method}</span></div>
<div style="padding:10px 0;border-bottom:1px solid #eee"><span>Tanggal: ${date}</span></div>
<div style="padding:16px 0 0;font-weight:700"><span>Total: ${fmt(amount)}</span></div>
</div>
<div style="text-align:center">
<a href="${APP_URL}/dashboard.php" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;text-decoration:none;border-radius:50px;font-weight:700">🚀 Mulai Menggunakan</a>
</div></div>
<div style="background:#f9f9f9;padding:20px;text-align:center;color:#888;font-size:12px">
© ${new Date().getFullYear()} ${APP_NAME}
</div></div></body></html>`;
    return sendEmail({ to, subject, html });
}

async function testConnection() {
    const transporter = getTransporter();
    if (!transporter) return { success: false, error: "SMTP not configured" };
    try {
        await transporter.verify();
        console.log("✅ [Email] SMTP connection OK");
        return { success: true };
    } catch (e) {
        console.error("❌ [Email] SMTP failed:", e.message);
        return { success: false, error: e.message };
    }
}

module.exports = {
    sendEmail,
    sendWelcomeEmail,
    sendPasswordResetEmail,
    sendReceiptEmail,
    testConnection,
    getTransporter,
};