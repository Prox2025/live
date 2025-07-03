const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL;

if (!SERVER_STATUS_URL) {
  console.error('❌ Variável de ambiente SERVER_STATUS_URL não definida');
  process.exit(1);
}

// Função para enviar o status ao servidor usando Puppeteer
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');

    console.log(`🌐 Acessando status API...`);
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
    return resposta;
  } catch (err) {
    console.error("❌ Erro ao enviar status:", err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

// Transmitir vídeo final sem aplicar filtros ou logo
async function rodarFFmpeg(videoPath, streamUrl, id) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-re', '-i', videoPath,
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
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    let notificado = false;

    const notificarInicio = async () => {
      if (!notificado) {
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
          console.log('✅ Início da live notificado');
        } catch (e) {
          console.error('⚠️ Falha ao notificar início:', e.message);
        }
        notificado = true;
      }
    };

    // Notifica assim que o ffmpeg começar a emitir stderr (início real)
    ffmpeg.stderr.once('data', () => {
      notificarInicio();
    });

    // Timeout como fallback para garantir notificação
    const timer = setTimeout(() => {
      notificarInicio();
    }, 60000);

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    ffmpeg.on('close', async (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.error('⚠️ Falha ao notificar término:', e.message);
        }
        resolve();
      } else {
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg erro ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg erro ${code}`));
      }
    });

    ffmpeg.on('error', async (err) => {
      clearTimeout(timer);
      try {
        await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

// Função principal
async function main() {
  try {
    const streamInfoPath = path.join(process.cwd(), 'stream_info.json');
    const videoPath = path.join(process.cwd(), 'video_final_completo.mp4');

    if (!fs.existsSync(streamInfoPath)) throw new Error('stream_info.json não encontrado');
    if (!fs.existsSync(videoPath)) throw new Error('video_final_completo.mp4 não encontrado');

    const info = JSON.parse(fs.readFileSync(streamInfoPath, 'utf-8'));
    const { stream_url, video_id } = info;

    if (!stream_url || !video_id) throw new Error('stream_url ou video_id ausente');

    console.log(`🚀 Iniciando transmissão para ${stream_url}`);
    await rodarFFmpeg(videoPath, stream_url, video_id);

  } catch (err) {
    console.error('💥 Erro fatal:', err.message);
    process.exit(1);
  }
}

main();
