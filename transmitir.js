const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL;

if (!SERVER_STATUS_URL) {
  console.error('❌ Variável SERVER_STATUS_URL não definida');
  process.exit(1);
}

async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');

    console.log(`🌐 Acessando API de status em ${SERVER_STATUS_URL}...`);
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
        return { status: 500, texto: 'Erro interno: ' + e.message };
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

async function rodarFFmpeg(videoPath, rodapePath, streamUrl, id) {
  return new Promise((resolve, reject) => {
    const filtro = [
      '[0:v]format=rgba[video]',
      '[1:v]format=rgba,setpts=PTS-STARTPTS+240/TB[rod]',
      '[video][rod]overlay=(main_w-overlay_w)/2:main_h-overlay_h:enable=\'between(t,240,240+duracao_rodape)\''
    ].join(';');

    // Primeiro, obter a duração do vídeo de rodapé
    const obterDuracaoRodape = () => {
      return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          rodapePath
        ]);
        let data = '';
        ffprobe.stdout.on('data', chunk => data += chunk.toString());
        ffprobe.on('close', code => {
          if (code === 0) resolve(parseFloat(data.trim()));
          else reject(new Error('❌ Não foi possível obter duração do rodapé'));
        });
      });
    };

    obterDuracaoRodape().then(duracao => {
      const filtroComTempo = filtro.replace(/duracao_rodape/g, duracao.toFixed(2));

      const args = [
        '-i', videoPath,
        '-i', rodapePath,
        '-filter_complex', filtroComTempo,
        '-map', '[outv]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '44100',
        '-f', 'flv',
        '-map_metadata', '-1',
        '-map_chapters', '-1',
        '-y',
        '-threads', '2',
        '-shortest',
        '-tune', 'zerolatency',
        '-g', '50',
        '-maxrate', '3500k',
        '-bufsize', '7000k',
        '-vf', 'format=yuv420p',
        '-strict', '-2',
        '-movflags', '+faststart',
        '-metadata', 'title="Live Stream"',
        streamUrl
      ];

      args.splice(args.indexOf('-filter_complex') + 2, 0, '-map', '[outv]');

      const ffmpeg = spawn('ffmpeg', args);

      let notificadoInicio = false;

      const notificarInicio = async () => {
        if (!notificadoInicio) {
          try {
            await enviarStatusPuppeteer({ id, status: 'started' });
            console.log('✅ Notificado início da transmissão');
          } catch (e) {
            console.error('⚠️ Falha ao notificar início:', e.message);
          }
          notificadoInicio = true;
        }
      };

      ffmpeg.stderr.once('data', () => {
        notificarInicio();
      });

      const fallbackTimer = setTimeout(() => {
        notificarInicio();
      }, 60000);

      ffmpeg.stdout.on('data', data => process.stdout.write(data));
      ffmpeg.stderr.on('data', data => process.stderr.write(data));

      ffmpeg.on('close', async (code) => {
        clearTimeout(fallbackTimer);
        if (code === 0) {
          try {
            await enviarStatusPuppeteer({ id, status: 'finished' });
            console.log('✅ Notificado término da transmissão com sucesso');
          } catch (e) {
            console.error('⚠️ Falha ao notificar término:', e.message);
          }
          resolve();
        } else {
          try {
            await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg saiu com código ${code}` });
          } catch (_) {}
          reject(new Error(`ffmpeg erro ${code}`));
        }
      });

      ffmpeg.on('error', async (err) => {
        clearTimeout(fallbackTimer);
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
        } catch (_) {}
        reject(err);
      });
    }).catch(reject);
  });
}

async function main() {
  try {
    const base = process.cwd();
    const streamInfoPath = path.join(base, 'stream_info.json');
    const videoPath = path.join(base, 'video_final_completo.mp4');
    const rodapePath = path.join(base, 'artefatos', 'rodape.webm');

    if (!fs.existsSync(videoPath)) throw new Error('video_final_completo.mp4 não encontrado');
    if (!fs.existsSync(streamInfoPath)) throw new Error('stream_info.json não encontrado');
    if (!fs.existsSync(rodapePath)) throw new Error('rodape.webm não encontrado em artefatos');

    const info = JSON.parse(fs.readFileSync(streamInfoPath, 'utf-8'));
    const { stream_url, id, video_id } = info;
    const liveId = id || video_id;

    if (!stream_url) throw new Error('stream_url ausente no stream_info.json');
    if (!liveId) throw new Error('id ausente no stream_info.json');

    console.log(`🚀 Iniciando transmissão para ${stream_url} (id: ${liveId})`);
    await rodarFFmpeg(videoPath, rodapePath, stream_url, liveId);

  } catch (err) {
    console.error('💥 Erro fatal:', err.message);
    process.exit(1);
  }
}

main();
