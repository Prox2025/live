const fs = require('fs');
const path = require('path');
const https = require('https');
const puppeteer = require('puppeteer');

// === CONFIGURAÇÕES ===
const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL || 'https://livestream.ct.ws/Google%20drive/status.php';
const delay = ms => new Promise(res => setTimeout(res, ms));

// === Enviar status ao servidor ===
async function enviarStatus(data) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);

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

// === Obter link de download direto com Puppeteer ===
async function obterLinkDownload(driveUrl) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(driveUrl, { waitUntil: 'networkidle2' });

    try {
      await page.waitForSelector('#uc-download-link', { timeout: 5000 });
      await page.click('#uc-download-link');
      console.log('🖱️ Botão "Baixar de qualquer forma" clicado...');
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
    } catch {
      console.log('⚠️ Botão não encontrado ou não necessário.');
    }

    const directLink = await page.evaluate(() => {
      const a = document.querySelector('a#uc-download-link, a[href*="export=download"]');
      return a ? a.href : window.location.href;
    });

    await browser.close();
    return directLink;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// === Baixar arquivo via HTTPS ===
function baixarArquivo(url, destino) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destino);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} - ${res.statusMessage}`));
        return;
      }

      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => reject(err));
  });
}

// === Transmitir via ffmpeg ===
function rodarFFmpeg(inputFile, streamUrl) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
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

    ffmpeg.stderr.on('data', d => process.stderr.write(d));
    ffmpeg.stdout.on('data', d => process.stdout.write(d));

    let notificou = false;
    const timer = setTimeout(async () => {
      if (!notificou) {
        try {
          await enviarStatus({ id: path.basename(inputFile, '.mp4'), status: 'started' });
          notificou = true;
          console.log('✅ Notificação enviada de início.');
        } catch (e) {
          console.error('⚠️ Falha ao notificar início:', e);
        }
      }
    }, 60000);

    ffmpeg.on('close', async (code) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');

      try {
        if (code === 0) {
          console.log('✅ Live concluída.');
          await enviarStatus({ id, status: 'finished' });
          resolve();
        } else {
          throw new Error(`ffmpeg saiu com código ${code}`);
        }
      } catch (e) {
        await enviarStatus({ id, status: 'error', message: e.message });
        reject(e);
      } finally {
        try {
          fs.unlinkSync(inputFile);
          console.log('🧹 Arquivo temporário removido.');
        } catch (_) {}
      }
    });

    ffmpeg.on('error', async (err) => {
      const id = path.basename(inputFile, '.mp4');
      await enviarStatus({ id, status: 'error', message: err.message });
      reject(err);
    });
  });
}

// === MAIN ===
(async () => {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      console.error('❌ JSON de entrada não encontrado');
      process.exit(1);
    }

    const { id, video_url, stream_url } = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!id || !video_url || !stream_url) throw new Error('JSON deve conter id, video_url e stream_url');

    console.log(`🚀 Iniciando live para vídeo ID: ${id}`);

    const arquivoLocal = path.join(process.cwd(), `${id}.mp4`);

    console.log('🌐 Obtendo link real de download via Puppeteer...');
    const linkDireto = await obterLinkDownload(video_url);
    console.log('🔗 Link direto obtido:', linkDireto);

    console.log('⬇️ Baixando vídeo...');
    await baixarArquivo(linkDireto, arquivoLocal);
    console.log('✅ Download concluído.');

    await rodarFFmpeg(arquivoLocal, stream_url);

  } catch (e) {
    console.error('💥 Erro fatal:', e);
    process.exit(1);
  }
})();
