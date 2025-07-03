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
      if (code === 0) {
        console.log(`✅ FFmpeg finalizado com sucesso.`);
        resolve();
      } else {
        reject(new Error(`❌ FFmpeg falhou com código ${code}`));
      }
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
  const client = await auth.getClient();
  console.log('🔓 Autenticação concluída com sucesso.');
  return client;
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
      if (code === 0) {
        resolve(parseFloat(output.trim()));
      } else {
        reject(new Error('❌ ffprobe falhou'));
      }
    });
  });
}

async function gerarImagemTexto(texto) {
  console.log(`🖊️ Gerando imagem com texto do rodapé: "${texto}"`);
  const pathTxt = 'descricao.txt';
  fs.writeFileSync(pathTxt, texto);
  registrarTemporario(pathTxt);
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=c=0x00000000:s=640x100',
    '-vf', `drawtext=textfile=${pathTxt}:fontcolor=white:fontsize=36:font='Arial':fontweight=900:x=10:y=30:shadowcolor=black:shadowx=2:shadowy=2`,
    '-frames:v', '1',
    'texto.png'
  ]);
  registrarTemporario('texto.png');
}

async function gerarRodapeAnimado(rodapeImg, textoImg) {
  console.log('🎨 Gerando rodapé animado com gradiente e texto...');
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=size=1280x100:duration=60:rate=30:color=black@0.0',
    '-i', rodapeImg,
    '-i', textoImg,
    '-filter_complex',
    `
      [1:v] scale=100x100 [img];
      [2:v] scale=1180x100 [txt];
      [0:v] format=yuva420p,
      drawbox=y=0:h=100:color=black@0.6:t=fill [bg];
      [bg][img] overlay=10:0 [tmp1];
      [tmp1][txt] overlay=120:0,
      fade=t=in:st=0:d=2:alpha=1,
      fade=t=out:st=58:d=2:alpha=1
    `.replace(/\s+/g, ' ').trim(),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-t', '60',
    'rodape_fade.mp4'
  ]);
  registrarTemporario('rodape_fade.mp4');
}

async function aplicarRodapeELogo(input, output, rodape, logo, mostrarLogo = true) {
  if (!fs.existsSync(rodape)) throw new Error(`❌ Rodapé não encontrado: ${rodape}`);
  if (!fs.existsSync('texto.png')) throw new Error('❌ texto.png não encontrado');

  console.log(`🧩 Aplicando rodapé animado e logo no vídeo: ${input}`);

  await gerarRodapeAnimado(rodape, 'texto.png');

  const overlays = ['-i', input, '-i', 'rodape_fade.mp4'];
  let filterComplex = "[0:v][1:v]overlay=0:H-overlay_h:enable='between(t,360,420)'[v]";

  if (mostrarLogo && fs.existsSync(logo)) {
    overlays.push('-i', logo);
    // Logo no canto superior direito, responsivo com tamanho pequeno
    filterComplex = "[0:v][1:v]overlay=0:H-overlay_h:enable='between(t,360,420)'[tmp];[tmp][2:v]overlay=W-w-20:20";
  }

  await executarFFmpeg([
    ...overlays,
    '-filter_complex', filterComplex,
    '-map', mostrarLogo ? '[v]' : '[v]',
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
  console.log(`🔄 Reencodando ${input} para ${output}...`);
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
  console.log(`✂️ Cortando vídeo ${input} ao meio em ${meio}s...`);
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
  registrarTemporario(out1);
  registrarTemporario(out2);
}

async function unirVideos(lista, saida) {
  console.log('🔗 Unindo vídeos...');
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

    // Campos obrigatórios para validar
    const camposObrigatorios = [
      'id',
      'video_principal',
      'logo_id',
      'rodape_id',
      'rodape_texto',
      'video_inicial',
      'video_miraplay',
      'video_final',
    ];

    const camposVazios = camposObrigatorios.filter(campo => {
      const valor = dados[campo];
      return valor === undefined || valor === null || valor === '';
    });

    if (camposVazios.length > 0) {
      console.error('❌ Os seguintes campos obrigatórios estão vazios ou ausentes:');
      camposVazios.forEach(campo => console.error(` - ${campo}`));
      throw new Error('❌ input.json está incompleto. Corrija os campos acima.');
    }

    console.log('✅ Todos os campos obrigatórios estão preenchidos.');

    const {
      video_principal,
      logo_id,
      rodape_id,
      rodape_texto,
      video_inicial,
      video_miraplay,
      video_final,
      videos_extras = []
    } = dados;

    // Baixar rodapé, logo e vídeo principal
    await baixarArquivo(rodape_id, 'footer.png', auth);

    if (rodape_texto && rodape_texto.trim().length > 0) {
      await gerarImagemTexto(rodape_texto);
    } else {
      console.log('⚠️ rodape_texto ausente ou vazio, gerando imagem transparente...');
      await executarFFmpeg(['-f', 'lavfi', '-i', 'color=c=0x00000000:s=640x100', '-frames:v', '1', 'texto.png']);
      registrarTemporario('texto.png');
    }

    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    // Obter duração para cortar vídeo ao meio
    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);

    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');

    // Aplicar rodapé animado e logo só nas partes do vídeo principal
    await aplicarRodapeELogo('parte1_re.mp4', 'parte1_final.mp4', 'footer.png', 'logo.png', true);
    await aplicarRodapeELogo('parte2_re.mp4', 'parte2_final.mp4', 'footer.png', 'logo.png', true);

    // Montar lista de vídeos para unir
    // Ordem: parte1_final, video_inicial, video_miraplay, videos_extras(5 primeiros), video_inicial novamente, parte2_final, video_final
    const arquivosParaUnir = ['parte1_final.mp4'];
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

      // Se for caminho local (termina com .mp4 e existe), adiciona direto
      if (typeof idVideo === 'string' && idVideo.endsWith('.mp4') && fs.existsSync(idVideo)) {
        arquivosParaUnir.push(idVideo);
        continue;
      }

      // Caso contrário, baixa e reencodeia
      const raw = `video_${i}_raw.mp4`;
      const final = `video_${i}.mp4`;

      await baixarArquivo(idVideo, raw, auth);
      await reencode(raw, final);
      arquivosParaUnir.push(final);
    }

    await unirVideos(arquivosParaUnir, 'video_final_completo.mp4');

    // Salvar info para streaming
    fs.writeFileSync('stream_info.json', JSON.stringify({ video_id: dados.id }, null, 2));

    console.log('🎉 Processo finalizado com sucesso! 🎬 Vídeo final: video_final_completo.mp4');

  } catch (err) {
    console.error('🚨 ERRO:', err.message);
    limparTemporarios();
    process.exit(1);
  }
})();
