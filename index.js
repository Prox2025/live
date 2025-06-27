import fs from 'fs';
import { exec, spawn } from 'child_process';
import puppeteer from 'puppeteer';
import https from 'https';
import path from 'path';

const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/status.php';

// Função delay simples
const delay = ms => new Promise(res => setTimeout(res, ms));

// Envia POST JSON via Puppeteer ao servidor de status
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();

    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);

    // Envia o POST com fetch no contexto da página
    const resposta = await page.evaluate(async (payload) => {
      const res = await fetch(window.location.href, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      const texto = await res.text();
      return {status: res.status, texto};
    }, data);

    await browser.close();
    return resposta;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function baixarVideo(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, response => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download falhou: status ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', err => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

async function rodarFFmpeg(inputFile, streamUrl) {
  return new Promise((resolve, reject) => {
    // ffmpeg args - 720p streaming com codec h264 e áudio AAC para facebook
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

    // Após 1 minuto avisa o servidor que a live começou
    const timer = setTimeout(async () => {
      if (!notifiedStart) {
        console.log('Enviando notificação de live iniciada ao servidor...');
        try {
          await enviarStatusPuppeteer({ id: path.basename(inputFile, '.mp4'), status: 'started' });
          notifiedStart = true;
          console.log('Notificação enviada com sucesso');
        } catch (e) {
          console.error('Erro notificando live iniciada:', e);
        }
      }
    }, 60000);

    ffmpeg.on('close', async (code) => {
      clearTimeout(timer);

      if (code === 0) {
        console.log('Live finalizada com sucesso, enviando status ao servidor...');
        try {
          await enviarStatusPuppeteer({ id: path.basename(inputFile, '.mp4'), status: 'finished' });
          console.log('Status final enviado com sucesso');
        } catch (e) {
          console.error('Erro notificando live finalizada:', e);
        }
        resolve();
      } else {
        console.error(`ffmpeg saiu com código ${code}`);
        try {
          await enviarStatusPuppeteer({ id: path.basename(inputFile, '.mp4'), status: 'error', message: `ffmpeg saiu com código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg saiu com código ${code}`));
      }

      // Remove arquivo local após terminar
      try {
        fs.unlinkSync(inputFile);
        console.log('Arquivo de vídeo local removido');
      } catch (e) {
        console.warn('Erro removendo arquivo de vídeo:', e);
      }
    });

    ffmpeg.on('error', async (err) => {
      clearTimeout(timer);
      console.error('Erro ffmpeg:', err);
      try {
        await enviarStatusPuppeteer({ id: path.basename(inputFile, '.mp4'), status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      console.error('JSON de entrada não encontrado:', jsonPath);
      process.exit(1);
    }

    const jsonRaw = fs.readFileSync(jsonPath, 'utf-8');
    const { id, video_url, stream_url } = JSON.parse(jsonRaw);

    if (!id || !video_url || !stream_url) {
      throw new Error('JSON deve conter id, video_url e stream_url');
    }

    console.log(`Iniciando live para vídeo ID: ${id}`);

    // Baixar vídeo
    const videoFile = path.join(process.cwd(), `${id}.mp4`);
    console.log(`Baixando vídeo de ${video_url} para ${videoFile}...`);
    await baixarVideo(video_url, videoFile);
    console.log('Download concluído.');

    // Rodar ffmpeg para streaming
    await rodarFFmpeg(videoFile, stream_url);

  } catch (err) {
    console.error('Erro fatal:', err);
    process.exit(1);
  }
}

main();
