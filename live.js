const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fsExtra = require('fs-extra');
const path = require('path');

const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL || 'https://livestream.ct.ws/Google%20drive/live/status.php';
const delay = ms => new Promise(res => setTimeout(res, ms));

// Envia status ao servidor via Puppeteer
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
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

// Baixa vídeo do Google Drive usando Puppeteer e axios
async function baixarVideo(idOuUrl, destino) {
  const url = idOuUrl.startsWith('http') ? idOuUrl : `https://drive.google.com/uc?id=${idOuUrl}&export=download`;
  console.log('🚀 Iniciando Puppeteer para capturar link de download...');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  let downloadUrl = null;

  page.on('response', async (response) => {
    const headers = response.headers();
    if (headers['content-disposition'] && headers['content-disposition'].includes('attachment')) {
      downloadUrl = response.url();
      console.log(`⚡ URL capturada de download: ${downloadUrl}`);
    }
  });

  console.log(`🌍 Acessando URL: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2' });

  try {
    console.log('⏳ Aguardando botão de download...');
    await page.waitForSelector('#uc-download-link', { timeout: 15000 });

    console.log('🖱️ Clicando no botão de download...');
    await page.click('#uc-download-link');

    console.log('⏳ Aguardando resposta de download...');
    const start = Date.now();
    while (!downloadUrl && (Date.now() - start) < 10000) {
      await delay(200);
    }

    if (!downloadUrl) throw new Error('❌ Link não capturado.');

    await browser.close();

    await fsExtra.ensureDir(path.dirname(destino));
    console.log('⬇️ Baixando vídeo para', destino);
    const response = await axios.get(downloadUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(destino);

    let totalBytes = 0;
    response.data.on('data', chunk => totalBytes += chunk.length);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    console.log(`✅ Download concluído (${(totalBytes / (1024*1024)).toFixed(2)} MB)`);

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// Rodar ffmpeg para transmissão ao vivo com filtros de qualidade
async function rodarFFmpeg(inputFile, streamUrl) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-re', '-i', inputFile,
      '-vf', 'scale=1280:720,unsharp=5:5:1.0:5:5:0.0,hqdn3d=1.5:1.5:6:6,eq=contrast=1.1:brightness=0.05:saturation=1.1',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
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
    await baixarVideo(video_url, videoFile);

    await rodarFFmpeg(videoFile, stream_url);

  } catch (err) {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
  }
}

main();
