
const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const arquivosTemporarios = [];

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`â–¶ï¸ Executando FFmpeg:\nffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`âŒ FFmpeg falhou com cÃ³digo ${code}`));
    });
  });
}

function registrarTemporario(arquivo) {
  arquivosTemporarios.push(arquivo);
}

function limparTemporarios() {
  console.log('ðŸ§¹ Limpando arquivos temporÃ¡rios...');
  for (const arquivo of arquivosTemporarios) {
    try {
      if (fs.existsSync(arquivo)) {
        fs.unlinkSync(arquivo);
        console.log(`ðŸ—‘ï¸ Removido: ${arquivo}`);
      }
    } catch (e) {
      console.warn(`âš ï¸ Falha ao remover ${arquivo}:`, e.message);
    }
  }
}

async function autenticar() {
  console.log('ðŸ” Autenticando no Google Drive...');
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  const client = await auth.getClient();
  console.log('ðŸ”“ AutenticaÃ§Ã£o concluÃ­da com sucesso.');
  return client;
}

async function baixarArquivo(fileId, destino, auth) {
  console.log(`ðŸ“¥ Baixando do Drive\nID: ${fileId}\nâ†’ ${destino}`);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    res.data.pipe(output);
    res.data.on('end', () => {
      console.log(`âœ… Download finalizado: ${destino}`);
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
      else reject(new Error('âŒ ffprobe falhou'));
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
    '-vf', "scale=1280:720",
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

async function aplicarRodapeELogoImagem(input, output, rodapeImagem, logo, duracao) {
  const tempos = [180, 300];
  const entrada_dur = 2;
  const dur = 15;
  let filtro = '';
  let base = '[0:v]';

  tempos.forEach((t, i) => {
    const fadeIn = t;
    const fadeOut = t + dur - entrada_dur;
    const fim = t + dur;
    filtro += `[1:v]scale=-1:60,fade=t=in:st=${fadeIn}:d=${entrada_dur},fade=t=out:st=${fadeOut}:d=2[rodape${i}]; `;
    filtro += `${base}[rodape${i}]overlay=0:H-h:enable='between(t,${t},${fim})'[tmp${i}]; `;
    base = `[tmp${i}]`;
  });

  filtro += `[2:v]scale=80:-1[logo]; ${base}[logo]overlay=W-w-10:10[final]`;

  await executarFFmpeg([
    '-i', input,
    '-i', rodapeImagem,
    '-i', logo,
    '-filter_complex', filtro,
    '-map', '[final]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-preset', 'veryfast',
    '-crf', '23',
    output
  ]);
  registrarTemporario(output);
}

async function unirVideos(lista, saida) {
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(f => `file '${f}'`).join('\n'));
  registrarTemporario(txt);
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
  console.log(`ðŸŽ¬ VÃ­deo final criado: ${saida}`);
}

(async () => {
  try {
    console.log('ðŸ“¦ Lendo input.json...');
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const obrigatorios = ['id', 'video_principal', 'logo_id', 'rodape_id', 'video_inicial', 'video_miraplay', 'video_final'];
    const faltando = obrigatorios.filter(k => !dados[k]);
    if (faltando.length) throw new Error('âŒ input.json incompleto:\n' + faltando.map(f => `- ${f}`).join('\n`));

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

    await aplicarRodapeELogoImagem('parte1_re.mp4', 'parte1_final.mp4', 'rodape_arquivo', 'logo.png', meio);
    await aplicarRodapeELogoImagem('parte2_re.mp4', 'parte2_final.mp4', 'rodape_arquivo', 'logo.png', duracao - meio);

    const videoIds = [video_inicial, video_miraplay, ...videos_extras, video_final];
    const arquivosProntos = ['parte1_final.mp4', 'parte2_final.mp4'];

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

    if (stream_url && id) {
      fs.writeFileSync('stream_info.json', JSON.stringify({ stream_url, id, video_id: id }, null, 2));
      console.log('ðŸ’¾ stream_info.json criado.');
    }

    limparTemporarios();

  } catch (error) {
    console.error('ðŸš¨ ERRO:', error.message);
    limparTemporarios();
    process.exit(1);
  }
})();
