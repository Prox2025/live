const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php';

async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: SCOPES,
  });
  return await auth.getClient();
}

async function baixarArquivoDrive(fileId, dest, keyFilePath) {
  const auth = await autenticar(keyFilePath);
  const drive = google.drive({ version: 'v3', auth });

  console.log(`⬇️ Baixando arquivo ID ${fileId} para ${dest}...`);

  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const destStream = fs.createWriteStream(dest);
    let tamanho = 0;

    res.data.on('data', chunk => tamanho += chunk.length);
    res.data.pipe(destStream);

    destStream.on('finish', () => {
      console.log(`✅ Download concluído (${(tamanho / 1024 / 1024).toFixed(2)} MB)`);
      resolve();
    });

    destStream.on('error', err => {
      console.error('❌ Erro ao salvar arquivo:', err);
      reject(err);
    });
  });
}

async function obterDuracaoVideo(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let output = '';
    ffprobe.stdout.on('data', (data) => output += data.toString());
    ffprobe.stderr.on('data', (data) => {}); // Ignorar erros ffprobe

    ffprobe.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe falhou'));
      const duracao = parseFloat(output);
      if (isNaN(duracao)) return reject(new Error('Não conseguiu obter duração'));
      resolve(duracao);
    });
  });
}

async function dividirVideo(inputFile, tempoSegundos, parte1Path, parte2Path) {
  // parte1: do início até tempoSegundos
  // parte2: do tempoSegundos até o final
  return new Promise((resolve, reject) => {
    // Dividir em 2 etapas (2 processos) para evitar erros complexos

    // Parte 1
    const args1 = [
      '-y', '-i', inputFile,
      '-t', tempoSegundos.toString(),
      '-c', 'copy',
      parte1Path
    ];
    const ffmpeg1 = spawn('ffmpeg', args1);
    ffmpeg1.stderr.on('data', d => process.stderr.write(d));
    ffmpeg1.on('close', (code1) => {
      if (code1 !== 0) return reject(new Error('Erro ao criar parte 1 do vídeo'));

      // Parte 2
      const args2 = [
        '-y', '-i', inputFile,
        '-ss', tempoSegundos.toString(),
        '-c', 'copy',
        parte2Path
      ];
      const ffmpeg2 = spawn('ffmpeg', args2);
      ffmpeg2.stderr.on('data', d => process.stderr.write(d));
      ffmpeg2.on('close', (code2) => {
        if (code2 !== 0) return reject(new Error('Erro ao criar parte 2 do vídeo'));
        resolve();
      });
    });
  });
}

async function unirVideosReencode(videos, output) {
  if (videos.length === 0) throw new Error("Nenhum vídeo para unir");

  const inputs = videos.flatMap(v => ['-i', v]);

  // Construir filtro concat com vídeo e áudio
  const n = videos.length;
  const filter = videos.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('') + `concat=n=${n}:v=1:a=1[outv][outa]`;

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-map', '[outa]',
    '-preset', 'veryfast',
    '-crf', '23',
    output
  ];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);
    ffmpeg.stderr.on('data', d => process.stderr.write(d));
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Erro ao unir vídeos (reencode), código ${code}`));
    });
  });
}

async function adicionarLogoAnimado(videoInput, logoPath, output) {
  /*
   - O logo ficará no topo direito, pequeno e responsivo.
   - O logo girará 360 graus a cada 3 segundos (180 graus a cada 1.5 segundos).
   - Usamos filtro rotate com expressão baseada no tempo.
  */
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoInput,
      '-i', logoPath,
      '-filter_complex',
      "[1:v]format=rgba,scale=iw*0.1:-1,rotate=2*PI*t/3:ow=rotw(2*PI*t/3):oh=roth(2*PI*t/3):c=none:fillcolor=0x00000000@0," +
      "format=rgba[logo_rot];" +
      "[0:v][logo_rot]overlay=W-w-10:10:format=auto",
      '-c:a', 'copy',
      output
    ];

    const ffmpeg = spawn('ffmpeg', args);

    ffmpeg.stderr.on('data', d => process.stderr.write(d));
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Erro ao adicionar logo, código ${code}`));
    });
  });
}

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

    await browser.close();
    return resposta;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function rodarFFmpeg(inputFile, streamUrl) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-re', '-i', inputFile,
      '-vf', 'scale=1280:720',
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

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    let notifiedStart = false;

    const timer = setTimeout(async () => {
      if (!notifiedStart) {
        const id = path.basename(inputFile, '.mp4');
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
          notifiedStart = true;
          console.log('✅ Início da live notificado');
        } catch (e) {
          console.error('⚠️ Falha ao notificar início:', e);
        }
      }
    }, 60000);

    ffmpeg.on('close', async (code) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');

      if (code === 0) {
        console.log('✅ Live finalizada. Notificando término...');
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.error('⚠️ Erro ao notificar término:', e);
        }
        resolve();
      } else {
        console.error(`❌ ffmpeg finalizou com erro (código ${code})`);
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg finalizou com código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg finalizou com erro (código ${code})`));
      }

      try {
        fs.unlinkSync(inputFile);
        console.log('🧹 Arquivo de vídeo removido');
      } catch (e) {
        console.warn('⚠️ Erro ao excluir vídeo:', e.message);
      }
    });

    ffmpeg.on('error', async (err) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');
      console.error('❌ Erro no ffmpeg:', err);
      try {
        await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      throw new Error('JSON de entrada não encontrado');
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const { id, video_drive_id, stream_url, chave_json, logo_id, video_extra_1, video_extra_2, video_extra_3 } = data;

    if (!id || !video_drive_id || !stream_url || !chave_json) {
      throw new Error('JSON deve conter id, video_drive_id, stream_url e chave_json');
    }

    const keyFilePath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyFilePath, chave_json);

    // Baixar vídeo principal
    const videoPrincipal = path.join(process.cwd(), `${id}_principal.mp4`);
    await baixarArquivoDrive(video_drive_id, videoPrincipal, keyFilePath);

    // Baixar vídeos extras e logo
    const videosExtras = [];
    if (video_extra_1) {
      const extra1 = path.join(process.cwd(), `${id}_extra1.mp4`);
      await baixarArquivoDrive(video_extra_1, extra1, keyFilePath);
      videosExtras.push(extra1);
    }
    if (video_extra_2) {
      const extra2 = path.join(process.cwd(), `${id}_extra2.mp4`);
      await baixarArquivoDrive(video_extra_2, extra2, keyFilePath);
      videosExtras.push(extra2);
    }
    if (video_extra_3) {
      const extra3 = path.join(process.cwd(), `${id}_extra3.mp4`);
      await baixarArquivoDrive(video_extra_3, extra3, keyFilePath);
      videosExtras.push(extra3);
    }

    let logoPath = null;
    if (logo_id) {
      logoPath = path.join(process.cwd(), `${id}_logo.png`);
      await baixarArquivoDrive(logo_id, logoPath, keyFilePath);
    }

    // Obter duração vídeo principal
    const duracao = await obterDuracaoVideo(videoPrincipal);
    const meio = duracao / 2;

    // Dividir vídeo principal em duas partes
    const parte1 = path.join(process.cwd(), `${id}_parte1.mp4`);
    const parte2 = path.join(process.cwd(), `${id}_parte2.mp4`);
    await dividirVideo(videoPrincipal, meio, parte1, parte2);

    // Montar lista final vídeos para concat
    // Ordem: parte1 + extras + parte2
    const listaVideos = [parte1, ...videosExtras, parte2];

    // Arquivo final antes do logo
    const videoUnido = path.join(process.cwd(), `${id}_final_unido.mp4`);

    // Unir vídeos com reencodificação
    console.log('🔗 Unindo vídeos (reencode)...');
    await unirVideosReencode(listaVideos, videoUnido);

    // Se houver logo, adicionar logo animado
    let videoComLogo = videoUnido;
    if (logoPath) {
      videoComLogo = path.join(process.cwd(), `${id}_final_logo.mp4`);
      console.log('🌀 Adicionando logo animado...');
      await adicionarLogoAnimado(videoUnido, logoPath, videoComLogo);
      // Apaga videoUnido para economizar espaço
      fs.unlinkSync(videoUnido);
    }

    // Exibir tamanho final
    const stats = fs.statSync(videoComLogo);
    console.log(`📏 Vídeo final criado: ${videoComLogo} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

    // Rodar ffmpeg para transmitir vídeo final
    console.log('▶️ Iniciando transmissão ao vivo...');
    await rodarFFmpeg(videoComLogo, stream_url);

    // Limpeza
    [videoPrincipal, parte1, parte2, ...videosExtras, logoPath, videoComLogo].forEach(file => {
      if (file && fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch {}
      }
    });
    fs.unlinkSync(keyFilePath);

  } catch (err) {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
  }
}

main();
