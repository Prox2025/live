const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const { https } = require('follow-redirects');
const { parse } = require('node-html-parser');

const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL || 'https://livestream.ct.ws/Google%20drive/status.php';
const delay = ms => new Promise(res => setTimeout(res, ms));

// Envia status ao servidor via Puppeteer
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);

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

// Baixar vídeo do Google Drive (inclusive arquivos grandes com página de confirmação)
async function baixarVideo(driveUrl, dest) {
  return new Promise((resolve, reject) => {
    const fileIdMatch = driveUrl.match(/id=([^&]+)/);
    if (!fileIdMatch) return reject(new Error('ID do arquivo do Google Drive não encontrado na URL'));

    const fileId = fileIdMatch[1];
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    https.get(downloadUrl, res => {
      let data = '';

      if (res.headers['content-disposition']) {
        // Se for download direto
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      } else {
        // Caso tenha o aviso de vírus
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const root = parse(data);
          const confirmLink = root.querySelector('a#uc-download-link');
          if (!confirmLink) return reject(new Error('Link de confirmação não encontrado.'));

          const confirmHref = confirmLink.getAttribute('href');
          const confirmUrl = `https://drive.google.com${confirmHref}`;

          https.get(confirmUrl, res2 => {
            const file = fs.createWriteStream(dest);
            res2.pipe(file);
            file.on('finish', () => file.close(resolve));
          }).on('error', err => reject(err));
        });
      }
    }).on('error', err => reject(err));
  });
}

// Rodar ffmpeg para transmitir o vídeo
async function rodarFFmpeg(inputFile, streamUrl) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-re', '-i', inputFile,
      '-vf', 'scale=w=1280:h=720:force_original_aspect_ratio=decrease',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-maxrate', '3000k',
      '-bufsize', '6000k',
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
        console.log('🔔 Notificando servidor que live começou...');
        try {
          await enviarStatusPuppeteer({ id: path.basename(inputFile, '.mp4'), status: 'started' });
          notifiedStart = true;
          console.log('✅ Notificação enviada');
        } catch (e) {
          console.error('⚠️ Erro notificando início da live:', e);
        }
      }
    }, 60000);

    ffmpeg.on('close', async (code) => {
      clearTimeout(timer);

      const id = path.basename(inputFile, '.mp4');
      if (code === 0) {
        console.log('✅ Live finalizada. Notificando servidor...');
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.error('⚠️ Erro notificando término:', e);
        }
        resolve();
      } else {
        console.error(`❌ ffmpeg finalizou com código ${code}`);
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg finalizou com código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg finalizou com código ${code}`));
      }

      try {
        fs.unlinkSync(inputFile);
        console.log('🧹 Arquivo de vídeo removido');
      } catch (e) {
        console.warn('⚠️ Erro ao remover vídeo:', e);
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

async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      console.error('❌ JSON de entrada não encontrado:', jsonPath);
      process.exit(1);
    }

    const { id, video_url, stream_url } = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

    if (!id || !video_url || !stream_url) {
      throw new Error('JSON deve conter id, video_url e stream_url');
    }

    console.log(`🚀 Iniciando live para vídeo ID: ${id}`);

    const videoFile = path.join(process.cwd(), `${id}.mp4`);
    console.log(`⬇️ Baixando vídeo de ${video_url} para ${videoFile}...`);
    await baixarVideo(video_url, videoFile);
    console.log('✅ Download concluído.');

    await rodarFFmpeg(videoFile, stream_url);

  } catch (err) {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
  }
}

main();
