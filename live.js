const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL || 'https://livestream.ct.ws/Google%20drive/status.php';
const delay = ms => new Promise(res => setTimeout(res, ms));

// Envia status ao servidor via Puppeteer
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
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

// Usa Puppeteer para obter o link real de download do Google Drive
async function obterLinkDownload(driveUrl) {
  console.log('ðŸŒ Obtendo link real de download via Puppeteer...');
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(driveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let directLink = driveUrl;
  try {
    await page.waitForSelector('#uc-download-link', { timeout: 7000 });
    const href = await page.$eval('#uc-download-link', el => el.href);
    console.log('ðŸ–±ï¸ BotÃ£o "Baixar de qualquer forma" clicado...');
    directLink = href;
  } catch {
    console.log('âš ï¸ BotÃ£o nÃ£o encontrado ou nÃ£o necessÃ¡rio.');
  }

  await browser.close();
  console.log('ðŸ”— Link direto obtido:', directLink);
  return directLink;
}

// Baixa o vÃ­deo via https e salva como arquivo local
async function baixarVideo(downloadUrl, dest) {
  const { https } = require('follow-redirects');
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(downloadUrl, response => {
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', err => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

// Rodar ffmpeg para transmitir o vÃ­deo
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
        console.log('ðŸ”” Notificando servidor que live comeÃ§ou...');
        try {
          await enviarStatusPuppeteer({ id: path.basename(inputFile, '.mp4'), status: 'started' });
          notifiedStart = true;
          console.log('âœ… NotificaÃ§Ã£o enviada');
        } catch (e) {
          console.error('âš ï¸ Erro notificando inÃ­cio da live:', e);
        }
      }
    }, 60000);

    ffmpeg.on('close', async (code) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');
      if (code === 0) {
        console.log('âœ… Live finalizada. Notificando servidor...');
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.error('âš ï¸ Erro notificando tÃ©rmino:', e);
        }
        resolve();
      } else {
        console.error(`âŒ ffmpeg saiu com cÃ³digo ${code}`);
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg saiu com cÃ³digo ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg saiu com cÃ³digo ${code}`));
      }

      try {
        fs.unlinkSync(inputFile);
        console.log('ðŸ§¹ Arquivo temporÃ¡rio removido.');
      } catch (e) {
        console.warn('âš ï¸ Erro ao remover arquivo:', e);
      }
    });

    ffmpeg.on('error', async (err) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');
      console.error('âŒ Erro no ffmpeg:', err);
      try {
        await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

// ExecuÃ§Ã£o principal
async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      console.error('âŒ JSON de entrada nÃ£o encontrado:', jsonPath);
      process.exit(1);
    }

    const { id, video_url, stream_url } = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

    if (!id || !video_url || !stream_url) {
      throw new Error('JSON deve conter id, video_url e stream_url');
    }

    console.log(`ðŸš€ Iniciando live para vÃ­deo ID: ${id}`);

    console.log(`ðŸŒ Obtendo link de download...`);
    const directLink = await obterLinkDownload(video_url);

    const videoFile = path.join(process.cwd(), `${id}.mp4`);
    console.log(`â¬‡ï¸ Baixando vÃ­deo...`);
    await baixarVideo(directLink, videoFile);
    console.log('âœ… Download concluÃ­do.');

    await rodarFFmpeg(videoFile, stream_url);

  } catch (err) {
    console.error('ðŸ’¥ Erro fatal:', err);
    process.exit(1);
  }
}

main();
