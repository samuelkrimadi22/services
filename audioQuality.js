// services/audioQuality.js
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function checkAudioQuality(audioPath, FFMPEG, FFPROBE) {
    try {
        const { stdout, stderr } = await execPromise(
            `"${FFMPEG}" -i "${audioPath}" -af "volumedetect" -f null -`,
            { timeout: 30000 }
        ).catch(e => ({ stdout: e.stdout || '', stderr: e.stderr || '' }));

        const output = (stdout || '') + (stderr || '');

        const rmsMatch = output.match(/mean_volume:\s*(-?[\d.]+)/);
        const peakMatch = output.match(/max_volume:\s*(-?[\d.]+)/);

        const rms = rmsMatch ? parseFloat(rmsMatch[1]) : -100;
        const peak = peakMatch ? parseFloat(peakMatch[1]) : -100;
        const dynamicRange = peak - rms;

        let quality = 'good';
        const warnings = [];

        if (rms < -30) {
            quality = 'poor';
            warnings.push('Volume terlalu pelan');
        }
        if (dynamicRange > 25) {
            quality = quality === 'poor' ? 'poor' : 'fair';
            warnings.push('Terlalu banyak noise (dinamika besar)');
        }
        if (peak > -0.5) {
            warnings.push('Audio terpotong (clipping)');
        }

        return {
            quality,
            rms: parseFloat(rms.toFixed(1)),
            peak: parseFloat(peak.toFixed(1)),
            dynamicRange: parseFloat(dynamicRange.toFixed(1)),
            warnings,
        };
    } catch (e) {
        return { quality: 'unknown', error: e.message };
    }
}

module.exports = { checkAudioQuality };