const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const { getVideoDurationInSeconds } = require('get-video-duration');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php'; // URL para enviar status

// --- Função para autenticar Google Drive ---
async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: SCOPES,
  });
  return auth.getClient();
}

// --- Função para baixar arquivo do Google Drive ---
async function baixarArquivo(fileId, dest, authClient) {
  const drive = google.drive({ version: 'v3', auth: authClient });
  console.log(`⬇️ Baixando arquivo ${fileId} para ${dest}...`);

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    const destStream = fs.createWriteStream(dest);
    let tamanho = 0;
    res.data.on('data', chunk => tamanho += chunk.length);
    res.data.pipe(destStream);

    destStream.on('finish', () => {
      console.log(`✅ Download concluído (${(tamanho / 1024 / 1024).toFixed(2)} MB)`);
      resolve();
    });
    destStream.on('error', reject);
  });
}

// --- Função para enviar status via Puppeteer ---
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
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
        return { status: 500, texto: 'Erro no fetch: ' + e.message };
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

// --- Função para cortar vídeo com ffmpeg ---
// corta um vídeo de input em [start, start+duration] e salva em output
function cortarVideo(input, output, start, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .setStartTime(start)
      .setDuration(duration)
      .output(output)
      .on('end', () => {
        console.log(`✂️ Corte concluído: ${output}`);
        resolve();
      })
      .on('error', reject)
      .run();
  });
}

// --- Função para criar um vídeo concatenado (concatenação demorada pelo filtro) ---
function concatenarVideos(videos, output) {
  return new Promise((resolve, reject) => {
    // Cria lista para concatenação por filter_complex
    // Vamos colocar todos os vídeos em inputs separados e concatenar via concat filter

    let ffmpegCommand = ffmpeg();

    videos.forEach(video => ffmpegCommand = ffmpegCommand.input(video));

    // Filtro concat com n streams, 1 video, 1 audio
    const n = videos.length;
    const filter = `[0:v:0][0:a:0]` + [...Array(n-1).keys()]
      .map(i => `[${i+1}:v:0][${i+1}:a:0]`)
      .join('') + `concat=n=${n}:v=1:a=1[outv][outa]`;

    ffmpegCommand
      .complexFilter([filter], ['outv', 'outa'])
      .outputOptions(['-map', '[outv]', '-map', '[outa]'])
      .output(output)
      .on('end', () => {
        console.log(`🔗 Vídeos concatenados em ${output}`);
        resolve();
      })
      .on('error', reject)
      .run();
  });
}

// --- Função para aplicar logo giratório e ajustar proporção 720x1280 ---
function aplicarLogoRotativo(inputVideo, logoImg, outputVideo) {
  return new Promise((resolve, reject) => {
    // Overlay no canto superior direito com tamanho responsivo (128x128 px)
    // Rotação a cada 3 segundos => rot = 2*PI*t / 3
    // Ajusta vídeo para 720x1280 (vertical)

    const filter = `
      [1:v]scale=128:128[logo];
      [0:v]scale=720:1280[video];
      [video][logo]overlay=W-w-10:10:rotate=2*PI*t/3
    `.replace(/\s+/g, ' ').trim();

    // Nota: FFmpeg não suporta rotate diretamente no overlay,
    // usaremos rotate no filtro do logo separado

    // Então separamos em steps: criar logo rotacionado, depois overlay

    ffmpeg()
      .input(inputVideo)
      .input(logoImg)
      .complexFilter([
        {
          filter: 'scale', options: '128:128', inputs: '1:v', outputs: 'logo_scaled'
        },
        {
          filter: 'rotate', options: '2*PI*t/3', inputs: 'logo_scaled', outputs: 'logo_rot'
        },
        {
          filter: 'scale', options: '720:1280', inputs: '0:v', outputs: 'video_scaled'
        },
        {
          filter: 'overlay', options: { x: 'W-w-10', y: '10' }, inputs: ['video_scaled', 'logo_rot'], outputs: 'final'
        }
      ], ['final'])
      .outputOptions(['-map', '[final]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k'])
      .output(outputVideo)
      .on('end', () => {
        console.log(`🎨 Logo aplicado e vídeo redimensionado em ${outputVideo}`);
        resolve();
      })
      .on('error', reject)
      .run();
  });
}

// --- Função para transmitir vídeo via ffmpeg para streamUrl ---
function transmitirVideo(inputVideo, streamUrl, id) {
  return new Promise((resolve, reject) => {
    const ffmpegProc = spawn('ffmpeg', [
      '-re',
      '-i', inputVideo,
      '-vf', 'scale=720:1280', // Ajuste para Facebook vertical
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
    ]);

    ffmpegProc.stdout.on('data', d => process.stdout.write(d));
    ffmpegProc.stderr.on('data', d => process.stderr.write(d));

    let notifiedStart = false;
    const timer = setTimeout(async () => {
      if (!notifiedStart) {
        try {
          console.log('🔔 Notificando início da live...');
          await enviarStatusPuppeteer({ id, status: 'started' });
          notifiedStart = true;
          console.log('✅ Notificado início da live');
        } catch (e) {
          console.error('⚠️ Erro notificando início:', e);
        }
      }
    }, 60000);

    ffmpegProc.on('close', async code => {
      clearTimeout(timer);
      if (code === 0) {
        console.log('✅ Live finalizada. Notificando término...');
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.error('⚠️ Erro notificando término:', e);
        }
        resolve();
      } else {
        console.error(`❌ ffmpeg finalizou com código de erro ${code}`);
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg finalizou com código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg finalizou com código ${code}`));
      }
      try { fs.unlinkSync(inputVideo); } catch {}
    });

    ffmpegProc.on('error', async err => {
      clearTimeout(timer);
      console.error('❌ Erro no ffmpeg:', err);
      try {
        await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

// --- Função principal ---
async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      throw new Error('JSON de entrada não encontrado');
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const { id, video_drive_id, stream_url, chave_json, logo_id, video_extra_1, video_extra_2, video_extra_3 } = data;

    if (!id || !video_drive_id || !stream_url || !chave_json) {
      throw new Error('Faltam campos obrigatórios no JSON');
    }

    const keyFilePath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyFilePath, JSON.stringify(chave_json));

    const authClient = await autenticar(keyFilePath);

    // Download vídeos
    const principalPath = path.join(process.cwd(), `${id}_principal.mp4`);
    await baixarArquivo(video_drive_id, principalPath, authClient);

    // Baixar vídeos extras (se definidos)
    const extras = [];
    for (const [idx, vid] of [[1, video_extra_1],[2, video_extra_2],[3, video_extra_3]].filter(([,v]) => v)) {
      const out = path.join(process.cwd(), `${id}_extra_${idx}.mp4`);
      await baixarArquivo(vid, out, authClient);
      extras.push(out);
    }

    // Baixar logo se definido
    let logoPath = null;
    if (logo_id) {
      logoPath = path.join(process.cwd(), `${id}_logo.png`);
      await baixarArquivo(logo_id, logoPath, authClient);
    }

    // Duração do vídeo principal
    const duracaoPrincipal = await getVideoDurationInSeconds(principalPath);
    console.log(`⏱ Duração vídeo principal: ${duracaoPrincipal.toFixed(2)}s`);

    const metade = duracaoPrincipal / 2;

    // Cortar vídeo principal em duas partes
    const parte1 = path.join(process.cwd(), `${id}_parte1.mp4`);
    const parte2 = path.join(process.cwd(), `${id}_parte2.mp4`);
    await cortarVideo(principalPath, parte1, 0, metade);
    await cortarVideo(principalPath, parte2, metade, duracaoPrincipal - metade);

    // Concatenar parte1 + vídeos extras + parte2
    const videosParaConcatenar = [parte1, ...extras, parte2];
    const videoConcat = path.join(process.cwd(), `${id}_concat.mp4`);
    await concatenarVideos(videosParaConcatenar, videoConcat);

    // Aplica logo rotativo (se existe)
    const videoFinal = path.join(process.cwd(), `final_${id}.mp4`);
    if (logoPath) {
      await aplicarLogoRotativo(videoConcat, logoPath, videoFinal);
    } else {
      // Se não tem logo, só redimensiona para 720x1280
      await new Promise((res, rej) => {
        ffmpeg(videoConcat)
          .size('720x1280')
          .outputOptions(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k'])
          .save(videoFinal)
          .on('end', () => {
            console.log('🔧 Vídeo final redimensionado sem logo');
            res();
          })
          .on('error', rej);
      });
    }

    // Limpar arquivos temporários
    [
      principalPath,
      parte1,
      parte2,
      videoConcat,
      ...extras,
      logoPath
    ].forEach(f => {
      if (f && fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch(e) { }
      }
    });

    // Transmitir vídeo final
    await transmitirVideo(videoFinal, stream_url, id);

    // Apagar chave temporária
    fs.unlinkSync(keyFilePath);

  } catch (err) {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
  }
}

main();
