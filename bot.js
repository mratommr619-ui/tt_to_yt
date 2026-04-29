const admin = require('firebase-admin');
const youtubeDl = require('yt-dlp-exec');
const { google } = require('googleapis');
const fs = require('fs');
const { execSync } = require('child_process');

// ၁။ YT-DLP Binary ကို သေချာအောင် Force Download လုပ်ခြင်း
try {
    console.log("Ensuring yt-dlp binary is present...");
    // GitHub Runner မှာ binary ပျောက်နေတတ်လို့ ပြန်သွင်းခိုင်းတာပါ
    execSync('npm install yt-dlp-exec@latest');
} catch (e) {
    console.log("Setup update skipped.");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

async function run() {
    const today = new Date().toISOString().split('T')[0];
    const tasks = await db.collection('automation_tasks').get();
    const channelCounters = {};

    for (const doc of tasks.docs) {
        const task = doc.data();
        const taskId = doc.id;
        const configId = task.youtube_config_id || 'account1';

        try {
            console.log(`-----------------------------------`);
            
            if (!channelCounters[configId]) {
                const statsRef = db.collection('stats').doc(`${configId}_${today}`);
                const statsDoc = await statsRef.get();
                channelCounters[configId] = statsDoc.exists ? statsDoc.data().count : 0;
            }

            if (channelCounters[configId] >= 10) {
                console.log(`⚠️ Limit (10) reached for ${configId}. Skipping...`);
                continue;
            }

            console.log(`Checking TikTok: ${task.tiktok_url}`);
            
            // ၂။ TikTok Info ယူခြင်း (Description နဲ့ Hashtags တွေပါအောင် ယူမယ်)
            const tiktokInfo = await youtubeDl(task.tiktok_url, { 
                dumpSingleJson: true, noCheckCertificates: true, playlistEnd: 1 
            });
            const video = tiktokInfo.entries[0];
            const uploaderName = video.uploader || "Unknown TikToker";

            // TikTok ရဲ့ မူရင်း Caption ကို ယူမယ်
            const originalCaption = video.description || video.title || "";
            
            if (task.tiktok_name !== uploaderName) {
                await db.collection('automation_tasks').doc(taskId).update({ tiktok_name: uploaderName });
            }

            if (video.id === task.last_video_id) {
                console.log(`[${uploaderName}] No new video.`);
                continue;
            }

            const filePath = `./${video.id}.mp4`;
            await youtubeDl(video.webpage_url, { output: filePath, format: 'mp4', noCheckCertificates: true });

            const configRef = db.collection('youtube_configs').doc(configId);
            const cfg = (await configRef.get()).data();
            const oauth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
            oauth2Client.setCredentials({ refresh_token: cfg.refresh_token });

            oauth2Client.on('tokens', async (tokens) => {
                if (tokens.refresh_token) {
                    await configRef.update({ refresh_token: tokens.refresh_token });
                }
            });

            const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
            
            // ၃။ YouTube ပေါ်တင်ခြင်း (Hashtags တွေပါအောင် ထည့်မယ်)
            console.log(`Uploading with Caption: ${originalCaption}`);
            await youtube.videos.insert({
                part: 'snippet,status',
                requestBody: {
                    snippet: { 
                        title: originalCaption.substring(0, 100), // Title က စာလုံး ၁၀၀ ပဲ လက်ခံလို့ပါ
                        description: `${originalCaption}\n\nCredit: ${uploaderName}\n#TikTok #Shorts #T8Automation`,
                        categoryId: '22' // People & Blogs
                    },
                    status: { privacyStatus: 'public' }
                },
                media: { body: fs.createReadStream(filePath) }
            });

            channelCounters[configId]++;
            await db.collection('stats').doc(`${configId}_${today}`).set({
                date: today, channel: configId, count: channelCounters[configId]
            });
            await db.collection('automation_tasks').doc(taskId).update({ last_video_id: video.id });

            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            console.log(`✅ Success [${configId}]: ${uploaderName}`);
            
        } catch (e) { 
            console.error(`❌ Error:`, e.message); 
        }
    }
}

run();
