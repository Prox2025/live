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
    const ffmpegArgs = ['-re', '-i', videoPath];

    let filtroLogo = 'null'; // filtro padrão se não houver logo

    if (logoPath && fs.existsSync(logoPath)) {
      ffmpegArgs.push('-loop', '1', '-i', logoPath);

      // Filtro complexo com nitidez (unsharp) + logo com escala, rotação e overlay no canto superior direito
      filtroLogo =
        `[0:v]unsharp=5:5:1.0:5:5:0.0[video_nitido];` + 
        `[1:v]scale=iw/6:ih/6,format=rgba,rotate=PI*t/3:c=none:ow=rotw(iw):oh=roth(ih)[logo];` +
        `[video_nitido][logo]overlay=W-w-10:10:shortest=1`;
    } else {
      // Se não houver logo, aplica nitidez só no vídeo
      filtroLogo = `[0:v]unsharp=5:5:1.0:5:5:0.0[video_nitido];[video_nitido]null`;
    }

    ffmpegArgs.push(
      '-filter_complex', filtroLogo,
      '-map', '[video_nitido]',
      '-map', '0:a?', // mapear áudio se existir
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

    if (!stream_url || !video_id) throw new Error('stream_url ou video_id ausente em stream_info.json');

    console.log(`🚀 Iniciando transmissão para ${stream_url}`);
    await rodarFFmpegComLogo(videoPath, fs.existsSync(logoPath) ? logoPath : null, stream_url, video_id);
  } catch (err) {
    console.error('💥 Erro fatal:', err.message);
    process.exit(1);
  }
}

main();
