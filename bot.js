const admin = require('firebase-admin');
const youtubeDl = require('yt-dlp-exec');
const { google } = require('googleapis');
const fs = require('fs');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function run() {
  const tasks = await db.collection('automation_tasks').get();
  for (const doc of tasks.docs) {
    const task = doc.data();
    try {
      console.log(`Checking: ${task.tiktok_url}`);
      const tiktokInfo = await youtubeDl(task.tiktok_url, { 
        dumpSingleJson: true, 
        noCheckCertificates: true, 
        playlistEnd: 1 
      });
      const video = tiktokInfo.entries[0];

      if (video.id === task.last_video_id) {
        console.log("No new video found.");
        continue;
      }

      console.log(`New video found: ${video.title}. Downloading...`);
      const filePath = `./${video.id}.mp4`;
      await youtubeDl(video.webpage_url, { output: filePath, format: 'mp4' });

      const cfg = (await db.collection('youtube_configs').doc(task.youtube_config_id).get()).data();
      const oauth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
      oauth2Client.setCredentials({ refresh_token: cfg.refresh_token });
      
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: { title: video.title, description: 'Auto Uploaded by Bot' },
          status: { privacyStatus: 'public' }
        },
        media: { body: fs.createReadStream(filePath) }
      });

      await db.collection('automation_tasks').doc(doc.id).update({ last_video_id: video.id });
      fs.unlinkSync(filePath);
      console.log(`Upload Success: ${video.title}`);
    } catch (e) { 
      console.error("Error details:", e.message); 
    }
  }
}
run();
