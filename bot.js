const admin = require('firebase-admin');
const youtubeDl = require('yt-dlp-exec');
const { google } = require('googleapis');
const fs = require('fs');
const { execSync } = require('child_process');

// ၁။ YT-DLP Auto-Update
try {
    console.log("Checking for yt-dlp updates...");
    execSync('npm install yt-dlp-exec@latest');
} catch (e) {
    console.log("Update skipped.");
}

// Firebase Setup
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

async function run() {
    const today = new Date().toISOString().split('T')[0];
    const tasks = await db.collection('automation_tasks').get();
    
    // Channel အလိုက် Counter ကို မှတ်ထားဖို့ Object တစ်ခုဆောက်မယ်
    const channelCounters = {};

    for (const doc of tasks.docs) {
        const task = doc.data();
        const taskId = doc.id;
        const configId = task.youtube_config_id || 'account1';

        try {
            console.log(`-----------------------------------`);
            
            // ၂။ အဲဒီ Channel အတွက် ဒီနေ့ ဘယ်နှစ်ပုဒ်တင်ပြီးပြီလဲ စစ်မယ်
            if (!channelCounters[configId]) {
                const statsRef = db.collection('stats').doc(`${configId}_${today}`);
                const statsDoc = await statsRef.get();
                channelCounters[configId] = statsDoc.exists ? statsDoc.data().count : 0;
            }

            // Channel တစ်ခုချင်းစီအတွက် ၁၀ ပုဒ် Limit စစ်ခြင်း
            if (channelCounters[configId] >= 10) {
                console.log(`⚠️ Limit reached for ${configId}. Skipping task...`);
                continue;
            }

            console.log(`Checking: ${task.tiktok_url} for Channel: ${configId}`);
            
            // ၃။ TikTok Info & Name Capture
            const tiktokInfo = await youtubeDl(task.tiktok_url, { 
                dumpSingleJson: true, noCheckCertificates: true, playlistEnd: 1 
            });
            
            const video = tiktokInfo.entries[0];
            const uploaderName = video.uploader || "Unknown TikToker";

            if (task.tiktok_name !== uploaderName) {
                await db.collection('automation_tasks').doc(taskId).update({ tiktok_name: uploaderName });
            }

            if (video.id === task.last_video_id) {
                console.log(`[${uploaderName}] No new video.`);
                continue;
            }

            // ၄။ Video Download
            console.log(`Downloading: ${video.title}`);
            const filePath = `./${video.id}.mp4`;
            await youtubeDl(video.webpage_url, { output: filePath, format: 'mp4', noCheckCertificates: true });

            // ၅။ YouTube Auth & Auto-Token Refresh
            const configRef = db.collection('youtube_configs').doc(configId);
            const cfg = (await configRef.get()).data();
            const oauth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
            oauth2Client.setCredentials({ refresh_token: cfg.refresh_token });

            oauth2Client.on('tokens', async (tokens) => {
                if (tokens.refresh_token) {
                    await configRef.update({ refresh_token: tokens.refresh_token });
                    console.log(`🔄 Refresh Token updated for ${configId}`);
                }
            });

            const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
            
            // YouTube Upload
            console.log(`Uploading to YouTube [${configId}]...`);
            await youtube.videos.insert({
                part: 'snippet,status',
                requestBody: {
                    snippet: { 
                        title: video.title || `Video by ${uploaderName}`, 
                        description: `Auto Uploaded\nTikTok: ${task.tiktok_url}` 
                    },
                    status: { privacyStatus: 'public' }
                },
                media: { body: fs.createReadStream(filePath) }
            });

            // ၆။ Channel အလိုက် Counter ကို Firestore မှာ Update လုပ်မယ်
            channelCounters[configId]++;
            await db.collection('stats').doc(`${configId}_${today}`).set({
                date: today,
                channel: configId,
                count: channelCounters[configId]
            });

            await db.collection('automation_tasks').doc(taskId).update({ last_video_id: video.id });

            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            console.log(`✅ Success! [${configId}] total: ${channelCounters[configId]}/10`);
            
        } catch (e) { 
            console.error(`❌ Error in task ${taskId}:`, e.message); 
        }
    }
}

run();
