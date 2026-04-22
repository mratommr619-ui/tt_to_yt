const admin = require('firebase-admin');
const youtubeDl = require('yt-dlp-exec');
const { google } = require('googleapis');
const fs = require('fs');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function run() {
  // --- တစ်ရက်စာ Limit စစ်ဆေးခြင်း ---
  const today = new Date().toISOString().split('T')[0]; // ဥပမာ "2024-05-20"
  const statsRef = db.collection('stats').doc('upload_counter');
  const statsDoc = await statsRef.get();
  
  let uploadCount = 0;
  if (statsDoc.exists && statsDoc.data().date === today) {
    uploadCount = statsDoc.data().count || 0;
  } else {
    // ရက်အသစ်ရောက်ရင် counter ကို ၀ ပြန်လုပ်မယ်
    await statsRef.set({ date: today, count: 0 });
  }

  if (uploadCount >= 10) {
    console.log("⚠️ Daily limit of 10 uploads reached. Stopping for today.");
    return;
  }
  // --------------------------------

  const tasks = await db.collection('automation_tasks').get();
  for (const doc of tasks.docs) {
    if (uploadCount >= 10) break; // ၁၀ ခုပြည့်ရင် Loop ကို ရပ်မယ်

    const task = doc.data();
    try {
      console.log(`Checking: ${task.tiktok_url}`);
      const tiktokInfo = await youtubeDl(task.tiktok_url, { 
        dumpSingleJson: true, noCheckCertificates: true, playlistEnd: 1 
      });
      const video = tiktokInfo.entries[0];

      if (video.id === task.last_video_id) {
        console.log("No new video.");
        continue;
      }

      console.log(`Downloading: ${video.title}`);
      const filePath = `./${video.id}.mp4`;
      await youtubeDl(video.webpage_url, { output: filePath, format: 'mp4' });

      const cfg = (await db.collection('youtube_configs').doc(task.youtube_config_id).get()).data();
      const oauth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
      oauth2Client.setCredentials({ refresh_token: cfg.refresh_token });
      
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: { title: video.title, description: 'Auto Uploaded' },
          status: { privacyStatus: 'public' }
        },
        media: { body: fs.createReadStream(filePath) }
      });

      // တင်ပြီးတိုင်း Counter ကို တိုးမယ်
      uploadCount++;
      await statsRef.update({ count: uploadCount });

      await db.collection('automation_tasks').doc(doc.id).update({ last_video_id: video.id });
      fs.unlinkSync(filePath);
      console.log(`✅ Uploaded (${uploadCount}/10): ${video.title}`);
      
    } catch (e) { 
      console.error("Error:", e.message); 
    }
  }
}
run();
