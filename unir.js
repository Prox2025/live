const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const arquivosTemporarios = [];

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ FFmpeg: ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`❌ FFmpeg falhou com código ${code}`));
    });
  });
}

function registrarTemporario(arquivo) {
  arquivosTemporarios.push(arquivo);
}

function limparTemporarios() {
  console.log('🧹 Limpando temporários...');
  for (const arquivo of arquivosTemporarios) {
    try {
      if (fs.existsSync(arquivo)) fs.unlinkSync(arquivo);
    } catch {}
  }
}

async function autenticar() {
  console.log('🔐 Autenticando...');
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  const client = await auth.getClient();
  console.log('🔓 Autenticado.');
  return client;
}

async function baixarArquivo(fileId, destino, auth) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    res.data.pipe(output);
    res.data.on('end', () => {
      registrarTemporario(destino);
      resolve();
    });
    res.data.on('error', err => reject(err));
  });
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video]);
    let output = '';
    ffprobe.stdout.on('data', chunk => output += chunk.toString());
    ffprobe.on('close', code => {
      if (code === 0) resolve(parseFloat(output.trim()));
      else reject(new Error('❌ ffprobe falhou'));
    });
  });
}

async function gerarImagemTexto(texto) {
  fs.writeFileSync('descricao.txt', texto);
  registrarTemporario('descricao.txt');
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=c=0x00000000:s=1180x100',
    '-vf', "drawtext=textfile=descricao.txt:fontcolor=white:fontsize=26:x=10:y=20:shadowcolor=black:shadowx=2:shadowy=2",
    '-frames:v', '1',
    'texto.png'
  ]);
  registrarTemporario('texto.png');
}

async function gerarRodapeComVisual(rodapeImg, textoImg, saida) {
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=black@0.6:size=1280x100',
    '-i', rodapeImg,
    '-i', textoImg,
    '-filter_complex',
    '[1:v] scale=100x100 [img]; [2:v] scale=1180x100 [txt]; [0:v][img] overlay=10:0 [tmp1]; [tmp1][txt] overlay=120:0',
    '-t', '600',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    saida
  ]);
  registrarTemporario(saida);
}

async function aplicarRodapeAnimado(input, rodapeFade, output) {
  await executarFFmpeg([
    '-i', input,
    '-i', rodapeFade,
    '-filter_complex',
    `[0:v][1:v] overlay=0:'if(lt(t,360), H, if(lt(t,361), H-(t-360)*100, if(lt(t,419), H-100, if(lt(t,420), H-100+(t-419)*100, H))))'[v];[0:a]anull[a]`,
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-shortest',
    output
  ]);
  registrarTemporario(output);
}

async function aplicarLogo(input, logo, output) {
  await executarFFmpeg([
    '-i', input,
    '-i', logo,
    '-filter_complex',
    '[0:v][1:v] overlay=W-w-20:20 [v]',
    '-map', '[v]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-shortest',
    output
  ]);
  registrarTemporario(output);
}

async function reencode(input, output) {
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720,fps=30',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

async function cortarVideo(input, out1, out2, meio) {
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
  registrarTemporario(out1);
  registrarTemporario(out2);
}

async function unirVideos(lista, saida) {
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(f => `file '${f}'`).join('\\n'));
  registrarTemporario(txt);
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
}

(async () => {
  try {
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const { video_principal, stream_url, id, logo_id, rodape_id, rodape_texto, videos_extras = [], video_inicial, video_miraplay, video_final } = dados;

    await baixarArquivo(rodape_id, 'footer.png', auth);
    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    if (rodape_texto) {
      await gerarImagemTexto(rodape_texto);
    } else {
      await executarFFmpeg(['-f', 'lavfi', '-i', 'color=c=0x00000000:s=640x100', '-frames:v', '1', 'texto.png']);
      registrarTemporario('texto.png');
    }

    await gerarRodapeComVisual('footer.png', 'texto.png', 'rodape_fade.mp4');

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;
    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');
    await aplicarLogo('parte1_re.mp4', 'logo.png', 'parte1_logo.mp4');
    await aplicarRodapeAnimado('parte1_logo.mp4', 'rodape_fade.mp4', 'parte1_final.mp4');
    await aplicarLogo('parte2_re.mp4', 'logo.png', 'parte2_logo.mp4');
    await aplicarRodapeAnimado('parte2_logo.mp4', 'rodape_fade.mp4', 'parte2_final.mp4');

    const arquivosProntos = ['parte1_final.mp4'];
    const videoIds = [
      video_inicial,
      video_miraplay,
      ...videos_extras.slice(0, 5),
      video_inicial,
      'parte2_final.mp4',
      video_final
    ];

    for (let i = 0; i < videoIds.length; i++) {
      const idVideo = videoIds[i];
      if (!idVideo) continue;
      const raw = `video_${i}_raw.mp4`;
      const final = `video_${i}.mp4`;
      await baixarArquivo(idVideo, raw, auth);
      await reencode(raw, final);
      arquivosProntos.push(final);
    }

    await unirVideos(arquivosProntos, 'video_final_completo.mp4');
    fs.writeFileSync('stream_info.json', JSON.stringify({ stream_url, video_id: id }, null, 2));
    console.log('✅ Finalizado: video_final_completo.mp4');
  } catch (err) {
    console.error('🚨 ERRO:', err.message);
    limparTemporarios();
    process.exit(1);
  }
})();
