const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

// URL status servidor
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php';

// Captura erros não tratados para log e saída clara
process.on('uncaughtException', (err) => {
  console.error('🛑 Uncaught Exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('🛑 Unhandled Rejection:', reason);
  process.exit(1);
});

async function enviarStatusPuppeteer(data) {
  console.log('Iniciando Puppeteer para enviar status...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');

    console.log(`Acessando URL de status: ${SERVER_STATUS_URL}`);
    await page.goto(SERVER_STATUS_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 3000));

    const resposta = await page.evaluate(async (payload) => {
      try {
        const res = await fetch(window.location.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const texto = await res.text();
        return { status: res.status, texto };
      } catch (e) {
        return { status: 500, texto: 'Erro interno no fetch: ' + e.message };
      }
    }, data);

    console.log('Resposta do servidor:', resposta);
    await browser.close();
    return resposta;
  } catch (err) {
    console.error('Erro ao enviar status:', err);
    await browser.close();
    throw err;
  }
}

async function rodarFFmpegComLogo(videoPath, logoPath, streamUrl, id) {
  return new Promise((resolve, reject) => {
    const temLogo = logoPath && fs.existsSync(logoPath);

    let filtroLogo = '';
    if (temLogo) {
      filtroLogo = `[1:v]format=rgba,rotate=2*PI*t/3:c=none:ow=rotw(2*PI*t/3):oh=roth(2*PI*t/3)[logo];` +
                   `[0:v][logo]overlay=W-w-10:10:shortest=1`;
    }

    const args = ['-re', '-i', videoPath];
    if (temLogo) {
      args.push('-loop', '1', '-i', logoPath);
      args.push('-filter_complex', filtroLogo);
    }
    args.push(
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
    );

    console.log('Executando ffmpeg com args:', args.join(' '));
    const ffmpeg = spawn('ffmpeg', args);

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    let notificado = false;
    const timer = setTimeout(async () => {
      if (!notificado) {
        console.log('Notificando início da live...');
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
          notificado = true;
          console.log('Início da live notificado com sucesso');
        } catch (e) {
          console.error('Erro ao notificar início:', e);
        }
      }
    }, 60000);

    ffmpeg.on('close', async (code) => {
      clearTimeout(timer);
      console.log(`ffmpeg terminou com código: ${code}`);
      if (code === 0) {
        console.log('Live finalizada com sucesso. Notificando término...');
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.error('Erro ao notificar término:', e);
        }
        resolve();
      } else {
        console.error(`Erro no ffmpeg (código ${code})`);
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg falhou com código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg erro ${code}`));
      }
    });

    ffmpeg.on('error', async err => {
      clearTimeout(timer);
      console.error('Erro fatal no ffmpeg:', err);
      try {
        await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

async function main() {
  try {
    const cwd = process.cwd();
    const streamInfoPath = path.join(cwd, 'stream_info.json');
    const videoPath = path.join(cwd, 'video_unido.mp4');
    const logoPath = path.join(cwd, 'logo.png');

    console.log('Verificando arquivos necessários...');
    if (!fs.existsSync(streamInfoPath)) throw new Error('Arquivo stream_info.json não encontrado');
    if (!fs.existsSync(videoPath)) throw new Error('Arquivo video_unido.mp4 não encontrado');

    const info = JSON.parse(fs.readFileSync(streamInfoPath, 'utf-8'));
    const { stream_url, video_id } = info;

    if (!stream_url) throw new Error('stream_url ausente em stream_info.json');
    if (!video_id) throw new Error('video_id ausente em stream_info.json');

    console.log(`Iniciando transmissão para stream_url: ${stream_url}`);
    await rodarFFmpegComLogo(videoPath, logoPath, stream_url, video_id);

  } catch (err) {
    console.error('Erro fatal no main:', err);
    process.exit(1);
  }
}

main();
