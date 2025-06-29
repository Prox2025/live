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
    if (!fs.existsSync(videoPath)) {
      return reject(new Error(`Vídeo não encontrado: ${videoPath}`));
    }

    const args = ['-re', '-i', videoPath];
    let filterComplex = '';
    let maps = ['-map', '[vout]', '-map', '0:a?', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100'];

    if (logoPath && fs.existsSync(logoPath)) {
      args.push('-loop', '1', '-i', logoPath);

      filterComplex = `
        [0:v]unsharp=5:5:1.0:5:5:0.0[base];
        [1:v]scale=100:100,format=rgba,
        rotate=PI/2*mod(t\\,5):c=none:ow=rotw(iw):oh=roth(ih)[logo];
        [base][logo]overlay=W-w-1:1[vout]
      `.replace(/\s+/g, ' ');
    } else {
      // Sem logo
      filterComplex = `[0:v]unsharp=5:5:1.0:5:5:0.0[vout]`;
    }

    args.push(
      '-filter_complex', filterComplex,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-maxrate', '3500k',
      '-bufsize', '7000k',
      '-pix_fmt', 'yuv420p',
      '-g', '50',
      ...maps,
      '-f', 'flv',
      streamUrl
    );

    console.log(`🎥 Comando FFmpeg: ffmpeg ${args.join(' ')}`);

    const ffmpeg = spawn('ffmpeg', args);

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    let notificado = false;
    const timer = setTimeout(async () => {
      if (!notificado) {
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
          notificado = true;
        } catch (e) {
          console.error('⚠️ Erro ao notificar início:', e.message);
        }
      }
    }, 60000);

    ffmpeg.on('close', async code => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.error('⚠️ Erro ao notificar término:', e.message);
        }
        resolve();
      } else {
        await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg finalizou com código ${code}` });
        reject(new Error(`ffmpeg finalizou com código ${code}`));
      }
    });

    ffmpeg.on('error', async err => {
      clearTimeout(timer);
      await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
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
