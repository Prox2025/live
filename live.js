const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php';

async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');

    console.log(`🌐 Acessando ${SERVER_STATUS_URL}`);
    await page.goto(SERVER_STATUS_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

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

    console.log("📡 Resposta do servidor:", resposta);
    await browser.close();
    return resposta;
  } catch (err) {
    console.error("❌ Erro ao enviar status:", err.message);
    await browser.close();
    throw err;
  }
}

async function rodarFFmpegComLogo(videoPath, logoPath, streamUrl, id) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-re',
      '-i', videoPath
    ];

    if (logoPath && fs.existsSync(logoPath)) {
      // Input da logo com framerate fixo para evitar congelamento
      ffmpegArgs.push(
        '-loop', '1',
        '-framerate', '30',
        '-i', logoPath,
        '-filter_complex',
        '[1:v]format=rgba,fps=30,rotate=PI*t/1.5:c=none:ow=rotw(iw):oh=roth(ih)[logo];' +
        '[0:v][logo]overlay=W-w-10:10'
      );
    } else {
      // Sem logo, usa vídeo original
      // Não precisa de filter_complex, só passa o vídeo
    }

    ffmpegArgs.push(
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
      '-shortest',
      '-f', 'flv',
      streamUrl
    );

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    let notificado = false;
    const timer = setTimeout(async () => {
      if (!notificado) {
        console.log('🔔 Notificando início da live...');
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
          notificado = true;
          console.log('✅ Início da live notificado');
        } catch (e) {
          console.error('⚠️ Erro ao notificar início:', e.message);
        }
      }
    }, 60000);

    ffmpeg.on('close', async code => {
      clearTimeout(timer);
      if (code === 0) {
        console.log('✅ Live finalizada. Notificando término...');
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.error('⚠️ Erro ao notificar término:', e.message);
        }
        resolve();
      } else {
        console.error(`❌ ffmpeg finalizou com erro (código ${code})`);
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg finalizou com código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg erro ${code}`));
      }
    });

    ffmpeg.on('error', async err => {
      clearTimeout(timer);
      console.error('❌ Erro fatal no ffmpeg:', err);
      try {
        await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

async function main() {
  try {
    const streamInfoPath = path.join(process.cwd(), 'stream_info.json');
    const videoPath = path.join(process.cwd(), 'video_unido.mp4');
    const logoPath = path.join(process.cwd(), 'logo.png');

    if (!fs.existsSync(streamInfoPath)) throw new Error('stream_info.json não encontrado');
    if (!fs.existsSync(videoPath)) throw new Error('video_unido.mp4 não encontrado');

    const info = JSON.parse(fs.readFileSync(streamInfoPath, 'utf-8'));
    const { stream_url, video_id } = info;

    if (!stream_url || !video_id) throw new Error('stream_url ou video_id ausente');

    console.log(`🚀 Iniciando transmissão para ${stream_url}`);
    await rodarFFmpegComLogo(videoPath, fs.existsSync(logoPath) ? logoPath : null, stream_url, video_id);
  } catch (err) {
    console.error('💥 Erro fatal:', err.message);
    process.exit(1);
  }
}

main();
