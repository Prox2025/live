const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const arquivosTemporarios = [];

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ Executando FFmpeg:\nffmpeg ${args.join(' ')}`);
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
  console.log('🧹 Limpando arquivos temporários...');
  for (const arquivo of arquivosTemporarios) {
    try {
      if (fs.existsSync(arquivo)) {
        fs.unlinkSync(arquivo);
        console.log(`🗑️ Removido: ${arquivo}`);
      }
    } catch (e) {
      console.warn(`⚠️ Falha ao remover ${arquivo}:`, e.message);
    }
  }
}

async function autenticar() {
  console.log('🔐 Autenticando no Google Drive...');
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  await auth.getClient();
  console.log('🔓 Autenticação concluída com sucesso.');
  return auth;
}

async function baixarArquivo(fileId, destino, auth) {
  console.log(`📥 Baixando do Drive\nID: ${fileId}\n→ ${destino}`);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    res.data.pipe(output);
    res.data.on('end', () => {
      console.log(`✅ Download finalizado: ${destino}`);
      registrarTemporario(destino);
      resolve();
    });
    res.data.on('error', err => reject(err));
  });
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let output = '';
    ffprobe.stdout.on('data', chunk => output += chunk.toString());
    ffprobe.on('close', code => {
      if (code === 0) resolve(parseFloat(output.trim()));
      else reject(new Error('❌ ffprobe falhou'));
    });
  });
}

async function cortarVideo(input, out1, out2, meio) {
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
  registrarTemporario(out1);
  registrarTemporario(out2);
}

async function reencode(input, output) {
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=960:720',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

async function aplicarRodape(input, output, rodapePath, logo, duracao, tipoRodape) {
  const tempos = [180, 300]; // minuto 3 e 5

  let filtros = '';
  let base = '[0:v]';

  if (tipoRodape === 'video') {
    const durRodape = await obterDuracao(rodapePath);
    tempos.forEach((inicio, i) => {
      const fim = (inicio + durRodape).toFixed(3);
      filtros += `[1:v]setpts=PTS-STARTPTS[r${i}]; `;
      filtros += `${base}[r${i}]overlay=0:H-h:enable='between(t,${inicio},${fim})'[tmp${i}]; `;
      base = `[tmp${i}]`;
    });
  } else {
    // imagem com animações simuladas (entrada e saída)
    tempos.forEach((inicio, i) => {
      const fim = inicio + 15;
      filtros += `[1:v]fade=t=in:st=${inicio}:d=1,fade=t=out:st=${fim}:d=1[r${i}]; `;
      filtros += `${base}[r${i}]overlay=0:H-h:enable='between(t,${inicio},${fim})'[tmp${i}]; `;
      base = `[tmp${i}]`;
    });
  }

  filtros += `[2:v]scale=80:-1[logo]; `;
  filtros += `${base}[logo]overlay=W-w-10:10[final]`;

  const args = [
    '-i', input,
    '-i', rodapePath,
    '-i', logo,
    '-filter_complex', filtros,
    '-map', '[final]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-preset', 'veryfast',
    '-crf', '23',
    output
  ];

  await executarFFmpeg(args);
  registrarTemporario(output);
}

async function unirVideos(lista, saida) {
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(f => `file '${f}'`).join('\n'));
  registrarTemporario(txt);
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
  console.log(`🎬 Vídeo final criado: ${saida}`);
}

(async () => {
  try {
    console.log('📦 Lendo input.json...');
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const obrigatorios = ['id', 'video_principal', 'logo_id', 'rodape_id', 'video_inicial', 'video_miraplay', 'video_final'];
    const faltando = obrigatorios.filter(k => !dados[k]);
    if (faltando.length) throw new Error('❌ input.json incompleto:\n' + faltando.map(f => `- ${f}`).join('\n'));

    const {
      id, video_principal, logo_id, rodape_id,
      videos_extras = [], video_inicial, video_miraplay, video_final, stream_url
    } = dados;

    await baixarArquivo(rodape_id, 'rodape_arquivo', auth);
    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');

    const rodapeExt = rodape_id.toLowerCase().endsWith('.mp4') ? 'video' : 'imagem';

    await aplicarRodape('parte1_re.mp4', 'parte1_final.mp4', 'rodape_arquivo', 'logo.png', meio, rodapeExt);
    await aplicarRodape('parte2_re.mp4', 'parte2_final.mp4', 'rodape_arquivo', 'logo.png', duracao - meio, rodapeExt);

    const videosExtrasFinalizados = [];

    async function processarVideo(fileId, nome) {
      await baixarArquivo(fileId, `${nome}_raw.mp4`, auth);
      await reencode(`${nome}_raw.mp4`, `${nome}.mp4`);
      return `${nome}.mp4`;
    }

    const vi = await processarVideo(video_inicial, 'video_inicial');
    const vm = await processarVideo(video_miraplay, 'video_miraplay');
    const vf = await processarVideo(video_final, 'video_final');

    for (let i = 0; i < videos_extras.length; i++) {
      if (!videos_extras[i]) continue;
      const nome = `video_extra_${i}`;
      const caminho = await processarVideo(videos_extras[i], nome);
      videosExtrasFinalizados.push(caminho);
    }

    const ordemFinal = [
      'parte1_final.mp4',
      vi,
      vm,
      ...videosExtrasFinalizados,
      vi,
      'parte2_final.mp4',
      vf
    ];

    await unirVideos(ordemFinal, 'video_final_completo.mp4');

    if (stream_url && id) {
      fs.writeFileSync('stream_info.json', JSON.stringify({ stream_url, id, video_id: id }, null, 2));
      console.log('💾 stream_info.json criado.');
    }

    limparTemporarios();

  } catch (error) {
    console.error('🚨 ERRO:', error.message);
    limparTemporarios();
    process.exit(1);
  }
})();
