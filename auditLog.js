// services/auditLog.js
// V9.8.0: Admin Audit Log — trace semua aksi admin
const { dbRun } = require("../database/db");

/**
 * Log aksi admin ke tabel activity_log
 * 
 * @param {number} adminId - User ID admin
 * @param {string} action - Jenis aksi (e.g., "user_delete", "plan_upgrade")
 * @param {string} details - Detail aksi
 * @param {object} req - Express request object (untuk IP + user agent)
 */
async function logAdminAction(adminId, action, details, req = null) {
    try {
        const ip = req 
            ? (req.ip || req.connection?.remoteAddress || "unknown")
            : "system";
        
        const userAgent = req 
            ? (req.headers?.["user-agent"] || null)
            : null;

        await dbRun(
            `INSERT INTO activity_log (user_id, action, details, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5)`,
            [adminId, action, details, ip, userAgent]
        );

        console.log(`📝 [Audit] ${action} by admin ${adminId}: ${details}`);
    } catch (e) {
        console.error("❌ [Audit] Gagal log:", e.message);
    }
}

/**
 * Log aksi user biasa (non-admin)
 */
async function logUserAction(userId, action, details, req = null) {
    try {
        const ip = req 
            ? (req.ip || req.connection?.remoteAddress || "unknown")
            : "system";
        
        const userAgent = req 
            ? (req.headers?.["user-agent"] || null)
            : null;

        await dbRun(
            `INSERT INTO activity_log (user_id, action, details, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, action, details, ip, userAgent]
        );
    } catch (e) {
        console.error("❌ [Audit] Gagal log user action:", e.message);
    }
}

/**
 * Ambil log dengan filter
 */
async function getAuditLogs({ 
    adminId = null, 
    action = null, 
    limit = 100, 
    offset = 0 
} = {}) {
    const { dbAll } = require("../database/db");
    
    let query = `
        SELECT 
            al.id,
            al.user_id,
            al.action,
            al.details,
            al.ip_address,
            al.user_agent,
            al.created_at,
            u.username,
            u.email,
            u.is_admin
        FROM activity_log al
        LEFT JOIN users u ON u.id = al.user_id
        WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;

    if (adminId) {
        query += ` AND al.user_id = $${paramCount++}`;
        params.push(adminId);
    }
    
    if (action) {
        query += ` AND al.action LIKE $${paramCount++}`;
        params.push(`%${action}%`);
    }
    
    query += ` ORDER BY al.created_at DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(limit, offset);
    
    return await dbAll(query, params);
}

/**
 * Total count untuk pagination
 */
async function countAuditLogs({ adminId = null, action = null } = {}) {
    const { dbAll } = require("../database/db");
    
    let query = `SELECT COUNT(*) as total FROM activity_log WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (adminId) {
        query += ` AND user_id = $${paramCount++}`;
        params.push(adminId);
    }
    
    if (action) {
        query += ` AND action LIKE $${paramCount++}`;
        params.push(`%${action}%`);
    }
    
    const result = await dbAll(query, params);
    return parseInt(result[0]?.total || 0);
}

module.exports = {
    logAdminAction,
    logUserAction,
    getAuditLogs,
    countAuditLogs,
};
