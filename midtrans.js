// services/midtrans.js - Midtrans Payment Gateway V9.2.1
const midtransClient = require('midtrans-client');
const crypto = require('crypto');

// ============================================================
// CONFIG
// ============================================================
const IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY;
const MERCHANT_ID = process.env.MIDTRANS_MERCHANT_ID;

if (!SERVER_KEY || !CLIENT_KEY) {
    console.warn('⚠️  [Midtrans] API keys tidak ditemukan di .env');
}

const snap = new midtransClient.Snap({
    isProduction: IS_PRODUCTION,
    serverKey: SERVER_KEY,
    clientKey: CLIENT_KEY
});

const core = new midtransClient.CoreApi({
    isProduction: IS_PRODUCTION,
    serverKey: SERVER_KEY,
    clientKey: CLIENT_KEY
});

console.log(`💳 [Midtrans] Mode: ${IS_PRODUCTION ? 'PRODUCTION 🔴' : 'SANDBOX 🟡'}`);
console.log(`💳 [Midtrans] Merchant: ${MERCHANT_ID || 'MISSING'}`);

// ============================================================
// V9.2.1: PLAN CONFIG
// ============================================================
const PLAN_CONFIG = {
    'monthly': {
        name: 'Pro Bulanan',
        price: 50000,           // ← Rp 50.000 normal
        early_price: 35000,     // ← Rp 35.000 untuk 100 user pertama
        duration_days: 30,
        db_plan: 'pro',
        daily_quota: 30,        // ← 30 video/hari
        max_duration: 600,      // ← 10 menit
        description: '30 video/hari, 10 menit/video, 1080p, no watermark, VO + Auto-Clip'
    },
    'business': {
        name: 'Business Bulanan',
        price: 150000,
        duration_days: 30,
        db_plan: 'business',
        daily_quota: 100,
        max_duration: 1800,     // 30 menit
        description: '100 video/hari, 30 menit/video, semua fitur + API + priority'
    }
};

function getPlanConfig(planKey) {
    if (!planKey) return null;
    return PLAN_CONFIG[planKey.toString().toLowerCase()] || null;
}

// ============================================================
// V9.2.1: Hitung harga efektif (early bird atau normal)
// ============================================================
function getEffectivePrice(planKey, appSettings) {
    const plan = getPlanConfig(planKey);
    if (!plan) return null;

    // Kalau plan punya early_price DAN masih ada slot early bird
    if (plan.early_price && appSettings) {
        const limit = parseInt(appSettings.early_bird_limit) || 100;
        const count = parseInt(appSettings.early_bird_count) || 0;
        if (count < limit) {
            console.log(`🎁 [Midtrans] Early bird aktif: ${count}/${limit} → Rp ${plan.early_price}`);
            return plan.early_price;
        }
    }

    return plan.price;
}

// ============================================================
// CREATE TRANSACTION — Bikin Snap token
// ============================================================
async function createTransaction({ orderId, amount, planKey, user, baseUrl }) {
    const plan = getPlanConfig(planKey);
    if (!plan) throw new Error(`Plan "${planKey}" tidak valid`);

    const url = baseUrl || process.env.BASE_URL || 'http://localhost';

    const parameter = {
        transaction_details: {
            order_id: orderId,
            gross_amount: amount
        },
        item_details: [{
            id: planKey,
            price: amount,
            quantity: 1,
            name: plan.name,
            category: 'Subscription'
        }],
        customer_details: {
            first_name: user.username || 'User',
            email: user.email,
            phone: user.phone || '08000000000'
        },
        callbacks: {
            finish: `${url}/harga.php?payment=success&order_id=${orderId}`,
            error: `${url}/harga.php?payment=error&order_id=${orderId}`,
            pending: `${url}/harga.php?payment=pending&order_id=${orderId}`
        },
        expiry: {
            unit: 'hours',
            duration: 24
        },
        credit_card: {
            secure: true
        },
        custom_field1: planKey,
        custom_field2: String(user.id),
        custom_field3: plan.name
    };

    console.log(`💳 [Midtrans] Create: ${orderId} (${plan.name} - Rp${amount})`);

    const transaction = await snap.createTransaction(parameter);

    return {
        token: transaction.token,
        redirect_url: transaction.redirect_url,
        order_id: orderId
    };
}

// ============================================================
// VERIFY TRANSACTION
// ============================================================
async function verifyTransaction(orderId) {
    try {
        const status = await core.transaction.status(orderId);
        return {
            success: true,
            status: status.transaction_status,
            fraud_status: status.fraud_status,
            payment_type: status.payment_type,
            gross_amount: parseFloat(status.gross_amount),
            order_id: status.order_id,
            transaction_id: status.transaction_id,
            raw: status
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ============================================================
// VERIFY WEBHOOK SIGNATURE
// ============================================================
function verifyWebhookSignature(notification) {
    const { order_id, status_code, gross_amount, signature_key } = notification;
    if (!signature_key) return false;

    const input = `${order_id}${status_code}${gross_amount}${SERVER_KEY}`;
    const expected = crypto.createHash('sha512').update(input).digest('hex');
    return expected === signature_key;
}

// ============================================================
// CHECK PAYMENT SUCCESS
// ============================================================
function isPaymentSuccess(transactionStatus, fraudStatus) {
    if (transactionStatus === 'settlement') return true;
    if (transactionStatus === 'capture' && fraudStatus === 'accept') return true;
    return false;
}

module.exports = {
    snap,
    core,
    PLAN_CONFIG,
    getPlanConfig,
    getEffectivePrice,
    createTransaction,
    verifyTransaction,
    verifyWebhookSignature,
    isPaymentSuccess
};