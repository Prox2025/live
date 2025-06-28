const fs = require('fs-extra');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const axios = require('axios');
const path = require('path');

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

// Nova função de download com Puppeteer + Axios
async function baixarVideo(entrada, destinoFinal) {
  const url = entrada.startsWith("http")
    ? entrada
    : `https://drive.google.com/uc?id=${entrada}&export=download`;

  console.log("🚀 Iniciando Puppeteer...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
  const page = await browser.newPage();

  let downloadUrl = null;

  page.on('response', async (response) => {
    const headers = response.headers();
    if (headers['content-disposition'] && headers['content-disposition'].includes('attachment')) {
      downloadUrl = response.url();
      console.log(`⚡ Capturada URL de download: ${downloadUrl}`);
    }
  });

  console.log(`🌍 Acessando URL: ${url}`);
  await page.goto(url, { waitUntil: "networkidle2" });

  try {
    console.log("⏳ Aguardando botão de download...");
    await page.waitForSelector('#uc-download-link', { timeout: 15000 });

    console.log("🖱️ Clicando no botão de download...");
    await page.click('#uc-download-link');

    console.log("⏳ Aguardando resposta de download...");
    const start = Date.now();
    while (!downloadUrl && (Date.now() - start) < 10000) {
      await new Promise(r => setTimeout(r, 200));
    }

    if (!downloadUrl) throw new Error("❌ Link de download não capturado.");

    await browser.close();

    await fs.ensureDir(path.dirname(destinoFinal));
    const writer = fs.createWriteStream(destinoFinal);

    console.log("⬇️ Baixando vídeo...");
    const response = await axios.get(downloadUrl, { responseType: 'stream' });
    let totalBytes = 0;
    response.data.on('data', chunk => totalBytes += chunk.length);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    console.log(`✅ Download concluído (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    await browser.close();
    console.error("❌ Erro ao baixar vídeo:", err.message);
    throw err;
  }
}

// Rodar ffmpeg para transmissão ao vivo
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
        } catch (_) { }
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
      } catch (_) { }
      reject(err);
    });
  });
}

// Execução principal
async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      console.error('❌ JSON de entrada não encontrado:', jsonPath);
      process.exit(1);
    }

    const { id, video_url, stream_url } = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));

    if (!id || !video_url || !stream_url) {
      throw new Error('JSON deve conter id, video_url e stream_url');
    }

    console.log(`🚀 Iniciando live para vídeo ID: ${id}`);

    const videoFile = path.join(process.cwd(), `${id}.mp4`);
    console.log(`⬇️ Baixando vídeo de ${video_url} para ${videoFile}...`);
    await baixarVideo(video_url, videoFile);

    await rodarFFmpeg(videoFile, stream_url);

  } catch (err) {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
  }
}

main();
