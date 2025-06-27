const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const https = require('https');

const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL || 'https://livestream.ct.ws/Google%20drive/status.php';
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

// Usa Puppeteer para obter o link real de download do Google Drive
async function obterLinkDownloadReal(driveUrl) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(driveUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);

    // Tenta clicar no botão "Baixar de qualquer forma" se existir
    try {
      await page.waitForSelector('#uc-download-link', { timeout: 5000 });
      await page.click('#uc-download-link');
      console.log('🖱️ Botão "Baixar de qualquer forma" clicado...');
      await delay(3000); // espera o redirecionamento carregar
    } catch {
      console.log('⚠️ Botão "Baixar de qualquer forma" não encontrado ou não necessário.');
    }

    // Agora pega o link direto do botão real de download
    // No Google Drive, o botão fica com id "uc-download-link" ou o link de download direto pode estar na URL
    const link = await page.evaluate(() => {
      const el = document.querySelector('#uc-download-link');
      if (el) return el.href;
      // Caso não tenha, tenta obter do meta refresh ou do url atual (redirecionado)
      return window.location.href;
    });

    await browser.close();

    if (!link) throw new Error('Não foi possível obter o link direto de download.');
    return link;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// Baixa o vídeo usando https nativo do Node.js
function baixarVideo(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    console.log('⬇️ Baixando vídeo de', url);

    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Falha no download. Código HTTP: ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

// Roda o ffmpeg para transmitir o vídeo
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

// Execução principal
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

    // Obtém o link real via Puppeteer
    console.log('🌐 Obtendo link real de download via Puppeteer...');
    const linkReal = await obterLinkDownloadReal(video_url);
    console.log('🔗 Link direto obtido:', linkReal);

    const videoFile = path.join(process.cwd(), `${id}.mp4`);

    await baixarVideo(linkReal, videoFile);
    console.log('✅ Download concluído.');

    await rodarFFmpeg(videoFile, stream_url);

  } catch (err) {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
  }
}

main();
