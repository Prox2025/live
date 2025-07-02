const { google } = require('googleapis');
const fs = require('fs');

const keyFile = 'chave.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const fileId = '1gyBX_J0DeIDDPAgEZfyNNVSAQmSBQo5N';

(async () => {
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  const client = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: client });

  const dest = fs.createWriteStream('logo_teste.png');

  try {
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    res.data.pipe(dest);
    res.data.on('end', () => console.log('✅ Logo baixado com sucesso'));
  } catch (err) {
    console.error('❌ Erro ao baixar o logo:', err.response?.data || err.message);
  }
})();
