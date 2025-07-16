const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const videoFile = 'video_final_completo.mp4';
const infoFile = 'stream_info.json';
const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL || '';

/**
 * Envia status ao servidor (via Puppeteer para renderizar JS da página).
 */
async function enviarStatusViaPuppeteer(payload) {
  if (!SERVER_STATUS_URL) return;

  console.log('📡 Enviando status ao servidor...', payload);

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 20000 });

    const result = await page.evaluate(async (payload) => {
      try {
        const res = await fetch(location.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, response: text };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, payload);

    await browser.close();

    if (result.ok) {
      console.log(`✅ Status enviado com sucesso: ${payload.status}`);
    } else {
      console.warn(`⚠️ Falha no envio (HTTP ${result.status || 'N/A'}): ${result.error || result.response}`);
    }
  } catch (err) {
    console.warn('⚠️ Erro ao usar puppeteer:', err.message);
  }
}

/**
 * Transmite o vídeo via FFmpeg para o RTMP.
 */
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
    await enviarStatusViaPuppeteer({ id, status: 'error', message: 'URL de transmissão ausente' });
    process.exit(1);
  }

  if (!fs.existsSync(videoFile)) {
    console.error(`❌ Vídeo "${videoFile}" não encontrado!`);
    await enviarStatusViaPuppeteer({ id, status: 'error', message: 'Arquivo de vídeo não encontrado' });
    process.exit(1);
  }

  console.log('▶️ Iniciando transmissão...');
  await enviarStatusViaPuppeteer({ id, status: 'started' });

  // Enviar status após 60 segundos de transmissão (seguro para Facebook)
  setTimeout(() => {
    enviarStatusViaPuppeteer({ id, status: 'streaming' });
  }, 60000);

  const ffmpeg = spawn('ffmpeg', [
    '-re',
    '-i', videoFile,
    '-c:v', 'libx264',
    '-profile:v', 'baseline',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-b:v', '2500k',
    '-maxrate', '2500k',
    '-bufsize', '5000k',
    '-g', '60', // GOP (2 segundos para 30fps)
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    streamUrl
  ], { stdio: 'inherit' });

  ffmpeg.on('close', async (code) => {
    if (code === 0) {
      console.log('✅ Transmissão concluída com sucesso.');
      await enviarStatusViaPuppeteer({ id, status: 'finished' });
    } else if (code === 251) {
      console.error('❌ Facebook cortou a transmissão (erro TLS / sessão encerrada).');
      await enviarStatusViaPuppeteer({
        id,
        status: 'interrupted',
        message: 'Facebook encerrou a live (RTMPS desconectado ou sessão finalizada).'
      });
    } else {
      console.error(`🚨 Erro na transmissão (código ${code})`);
      await enviarStatusViaPuppeteer({
        id,
        status: 'error',
        message: `FFmpeg falhou com código ${code}`
      });
    }
  });
}

// Executa com tratamento de erro fatal
transmitir().catch(async (err) => {
  console.error('🚨 Erro fatal:', err.message);
  await enviarStatusViaPuppeteer({ id: 'desconhecido', status: 'error', message: err.message });
  process.exit(1);
});
