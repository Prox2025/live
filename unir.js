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

async function cortarVideo(input, out1, out2, meio) {
  console.log(`✂️ Cortando vídeo ${input}...`);
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
  registrarTemporario(out1);
  registrarTemporario(out2);
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

async function gerarImagemTexto(texto, output) {
  console.log(`🖊️ Gerando imagem de texto para rodapé...`);
  const txtFile = 'descricao.txt';
  fs.writeFileSync(txtFile, texto);
  registrarTemporario(txtFile);
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=black@0.0:size=640x100',
    '-vf', `drawtext=textfile=${txtFile}:fontcolor=white:fontsize=36:font=Arial:shadowcolor=black:shadowx=2:shadowy=2:x=10:y=30`,
    '-frames:v', '1',
    output
  ]);
  registrarTemporario(output);
}

async function gerarRodapeComGradienteEAnimacao(rodapeImg, textoImg, saida) {
  console.log('🎨 Gerando rodapé com gradiente e animação suave...');

  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=black@0.0:size=1280x60',
    '-loop', '1',
    '-i', rodapeImg,
    '-loop', '1',
    '-i', textoImg,
    '-filter_complex',
    `[1:v]format=rgba,fade=t=in:st=0:d=2:alpha=1,fade=t=out:st=28:d=2:alpha=1,scale=100:60[rodape];
     [2:v]format=rgba,fade=t=in:st=0:d=2:alpha=1,fade=t=out:st=28:d=2:alpha=1,scale=1180:60[texto];
     [0:v][rodape]overlay=10:0:format=auto[tmp1];
     [tmp1][texto]overlay=120:0:format=auto,format=yuv420p,trim=duration=30,setsar=1`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-t', '30',
    saida
  ]);
  registrarTemporario(saida);
}

async function aplicarRodapeELogo(input, output, rodape, logo) {
  if (!fs.existsSync(rodape)) throw new Error(`❌ Rodapé não encontrado: ${rodape}`);
  if (!fs.existsSync(logo)) throw new Error(`❌ Logo não encontrado: ${logo}`);

  console.log(`🎥 Aplicando rodapé e logo ao vídeo: ${input}`);

  // Rodapé aparece entre 360s (6:00) e 390s (6:30) com fade in/out de 2s
  // Logo fica visível durante toda a duração do vídeo

  const filterComplex = `
    [1:v]format=rgba,fade=t=in:st=0:d=2:alpha=1,fade=t=out:st=28:d=2:alpha=1[rodape_fade];
    [2:v]format=rgba[logo];
    [0:v][rodape_fade]overlay=0:H-h:enable='between(t,360,390)'[tmp];
    [tmp][logo]overlay=W-w-10:10
  `.replace(/\s+/g, ' ').trim();

  await executarFFmpeg([
    '-i', input,
    '-i', rodape,
    '-i', logo,
    '-filter_complex', filterComplex,
    '-c:a', 'copy',
    '-preset', 'veryfast',
    '-crf', '23',
    output
  ]);

  registrarTemporario(output);
}

async function unirVideos(lista, saida) {
  console.log('🔗 Unindo vídeos finais...');
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
      console.log('❌ Os seguintes campos obrigatórios estão vazios ou ausentes:');
      camposVazios.forEach(c => console.log(` - ${c}`));
      throw new Error('❌ input.json está incompleto. Corrija os campos acima.');
    }
    console.log('✅ Todos os campos obrigatórios estão preenchidos.');

    const {
      video_principal,
      logo_id,
      rodape_id,
      rodape_texto,
      videos_extras = [],
      video_inicial,
      video_miraplay,
      video_final
    } = dados;

    await baixarArquivo(rodape_id, 'footer.png', auth);
    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    await gerarImagemTexto(rodape_texto, 'texto.png');

    await gerarRodapeComGradienteEAnimacao('footer.png', 'texto.png', 'rodape_fade.mp4');

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;
    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);

    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');

    // Aplica rodapé e logo nas partes 1 e 2
    await aplicarRodapeELogo('parte1_re.mp4', 'parte1_final.mp4', 'rodape_fade.mp4', 'logo.png');
    await aplicarRodapeELogo('parte2_re.mp4', 'parte2_final.mp4', 'rodape_fade.mp4', 'logo.png');

    // Processar vídeos extras e vídeos fixos
    const videoIds = [
      video_inicial,
      video_miraplay,
      ...videos_extras,
      video_inicial,
      'parte2_final.mp4',
      video_final
    ];

    const arquivosProntos = ['parte1_final.mp4'];

    for (let i = 0; i < videoIds.length; i++) {
      const idVideo = videoIds[i];
      if (!idVideo) continue;

      if (idVideo.endsWith('.mp4') && fs.existsSync(idVideo)) {
        arquivosProntos.push(idVideo);
        continue;
      }

      const raw = `video_${i}_raw.mp4`;
      const final = `video_${i}.mp4`;
      await baixarArquivo(idVideo, raw, auth);
      await reencode(raw, final);
      arquivosProntos.push(final);
    }

    await unirVideos(arquivosProntos, 'video_final_completo.mp4');

    limparTemporarios();

  } catch (error) {
    console.error('🚨 ERRO:', error.message);
    limparTemporarios();
    process.exit(1);
  }
})();
