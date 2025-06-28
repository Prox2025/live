const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php'; // ajuste conforme necessário

// Autenticação Google API
async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: SCOPES,
  });
  return await auth.getClient();
}

// Baixa arquivo do Drive via API
async function baixarVideo(fileId, dest, keyFilePath) {
  const auth = await autenticar(keyFilePath);
  const drive = google.drive({ version: 'v3', auth });

  console.log(`⬇️ Baixando vídeo ID ${fileId} para ${dest}...`);

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    const destStream = fs.createWriteStream(dest);
    let tamanho = 0;

    res.data.on('data', chunk => tamanho += chunk.length);
    res.data.pipe(destStream);

    destStream.on('finish', () => {
      console.log(`✅ Download concluído (${(tamanho / 1024 / 1024).toFixed(2)} MB)`);
      resolve();
    });

    destStream.on('error', err => {
      console.error('❌ Erro ao salvar vídeo:', err);
      reject(err);
    });
  });
}

// Notifica o status da live para o servidor via Puppeteer
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    const resposta = await page.evaluate(async (payload) => {
      const res = await fetch(window.location.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const texto = await res.text();
      return { status: res.status, texto };
    }, data);

    await browser.close();
    return resposta;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// Transmitir vídeo com ffmpeg
async function rodarFFmpeg(inputFile, streamUrl) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-re', '-i', inputFile,
      '-vf', 'scale=1280:720,unsharp=5:5:1.0:5:5:0.0,hqdn3d=1.5:1.5:6:6,eq=contrast=1.1:brightness=0.05:saturation=1.1',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-maxrate', '3500k',
      '-bufsize', '7000k',
      '-pix_fmt', 'yuv420p',
      '-g', '50',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-f', 'flv',
      streamUrl
    ]);

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    let notifiedStart = false;

    const timer = setTimeout(async () => {
      if (!notifiedStart) {
        console.log('🔔 Notificando início da live...');
        try {
          await enviarStatusPuppeteer({ id: path.basename(inputFile, '.mp4'), status: 'started' });
          notifiedStart = true;
          console.log('✅ Início notificado');
        } catch (e) {
          console.error('⚠️ Erro ao notificar início:', e);
        }
      }
    }, 60000);

    ffmpeg.on('close', async (code) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');

      if (code === 0) {
        console.log('✅ Live finalizada');
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.error('⚠️ Erro ao notificar fim:', e);
        }
        resolve();
      } else {
        console.error(`❌ ffmpeg falhou (código ${code})`);
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg falhou com código ${code}`));
      }

      try {
        fs.unlinkSync(inputFile);
        console.log('🧹 Arquivo local removido');
      } catch (e) {
        console.warn('⚠️ Erro ao remover arquivo:', e);
      }
    });

    ffmpeg.on('error', async (err) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');
      console.error('❌ Erro no ffmpeg:', err);
      try {
        await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

// Ponto de entrada
async function main() {
  try {
    const inputPath = process.argv[2];
    const keyPath = process.argv[3];

    if (!inputPath || !fs.existsSync(inputPath)) {
      console.error('❌ input.json não encontrado:', inputPath);
      process.exit(1);
    }
    if (!keyPath || !fs.existsSync(keyPath)) {
      console.error('❌ chave.json não encontrado:', keyPath);
      process.exit(1);
    }

    const { id, stream_url } = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

    if (!id || !stream_url) {
      throw new Error('input.json deve conter "id" e "stream_url"');
    }

    console.log(`🚀 Iniciando live para vídeo ID: ${id}`);

    const videoPath = `${id}.mp4`;
    await baixarVideo(id, videoPath, keyPath);

    await rodarFFmpeg(videoPath, stream_url);

  } catch (err) {
    console.error('💥 Erro fatal:', err.message);
    process.exit(1);
  }
}

main();
