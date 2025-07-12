const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const videoFile = 'video_final_completo.mp4';
const infoFile = 'stream_info.json';
const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL || '';

async function enviarStatus(payload) {
  if (!SERVER_STATUS_URL) return;

  console.log('📡 Enviando status ao servidor...', payload);

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // <- 👈 necessário para ambientes restritos
    });

    const page = await browser.newPage();

    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 15000 });

    const result = await page.evaluate(async (payload) => {
      try {
        const res = await fetch(location.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return { ok: res.ok, status: res.status };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, payload);

    await browser.close();

    if (result.ok) {
      console.log('✅ Status enviado com sucesso:', payload.status);
    } else {
      console.warn(`⚠️ Falha no envio (HTTP ${result.status || 'N/A'}): ${result.error || 'desconhecido'}`);
    }

  } catch (err) {
    console.warn('⚠️ Erro ao enviar status (puppeteer):', err.message);
  }
}

async function transmitir() {
  if (!fs.existsSync(infoFile)) {
    console.error('❌ Arquivo stream_info.json não encontrado!');
    process.exit(1);
  }

  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  const streamUrl = info.stream_url;
  const id = info.id || 'sem_id';

  if (!streamUrl) {
    console.error('❌ stream_url não definida!');
    await enviarStatus({ id, status: 'error', message: 'URL de transmissão ausente' });
    process.exit(1);
  }

  if (!fs.existsSync(videoFile)) {
    console.error(`❌ Vídeo "${videoFile}" não encontrado!`);
    await enviarStatus({ id, status: 'error', message: 'Arquivo de vídeo não encontrado' });
    process.exit(1);
  }

  console.log('▶️ Iniciando transmissão...');
  await enviarStatus({ id, status: 'started' });

  const ffmpeg = spawn('ffmpeg', [
    '-re',
    '-i', videoFile,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    streamUrl
  ], { stdio: 'inherit' });

  ffmpeg.on('close', async (code) => {
    if (code === 0) {
      console.log('✅ Transmissão concluída com sucesso.');
      await enviarStatus({ id, status: 'finished' });
    } else {
      console.error(`🚨 Erro na transmissão (código ${code})`);
      await enviarStatus({ id, status: 'error', message: `FFmpeg falhou com código ${code}` });
    }
  });
}

transmitir().catch(async (err) => {
  console.error('🚨 Erro fatal:', err);
  const id = 'desconhecido';
  await enviarStatus({ id, status: 'error', message: err.message });
  process.exit(1);
});
