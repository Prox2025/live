const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const arquivosTemporarios = [];

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ ffmpeg ${args.join(' ')}`);
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

async function gerarImagemTexto(texto) {
  console.log(`🖊️ Gerando imagem com texto: "${texto}"`);
  const pathTxt = 'descricao.txt';
  fs.writeFileSync(pathTxt, texto);
  registrarTemporario(pathTxt);
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=c=0x00000000:s=640x100',
    '-vf', `drawtext=textfile=${pathTxt}:fontcolor=white:fontsize=26:x=10:y=20:shadowcolor=black:shadowx=2:shadowy=2`,
    '-frames:v', '1',
    'texto.png'
  ]);
  registrarTemporario('texto.png');
}

async function gerarRodapeComVisual(rodapeImg, textoImg, saida) {
  console.log('🎨 Gerando rodapé com gradiente e layout personalizado...');
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=size=1280x100:duration=60:rate=25:color=black@0',
    '-i', rodapeImg,
    '-i', textoImg,
    '-filter_complex',
    // Usando um gradiente simulando seu CSS aproximado via overlay alpha
    '[0:v]format=rgba,geq=r=\'p(X,Y)\':g=\'p(X,Y)\':b=\'p(X,Y)\':a=\'if(lte(Y,0),255,if(lte(Y,25),180,if(lte(Y,50),100,if(lte(Y,85),30,0))))\'[grad];' +
    '[1:v] scale=100:100 [img];' +
    '[2:v] scale=1180:100 [txt];' +
    '[grad][img] overlay=10:0 [tmp1];' +
    '[tmp1][txt] overlay=120:0',
    '-t', '60',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    saida
  ]);
  registrarTemporario(saida);
}

async function aplicarRodapeELogo(input, output, rodape, logo) {
  if (!fs.existsSync(rodape)) throw new Error(`❌ Rodapé não encontrado: ${rodape}`);
  if (!fs.existsSync(logo)) throw new Error(`❌ Logo não encontrado: ${logo}`);
  if (!fs.existsSync('texto.png')) throw new Error('❌ texto.png não encontrado');

  console.log(`🧩 Compondo rodapé e logo no vídeo: ${input}`);

  await gerarRodapeComVisual(rodape, 'texto.png', 'rodape_fade.mp4');

  await executarFFmpeg([
    '-i', input,
    '-i', logo,
    '-i', 'rodape_fade.mp4',
    '-filter_complex',
    // rodapé na base (bottom), logo no topo direito, com margem responsiva
    `[0:v][2:v] overlay=0:main_h-overlay_h:format=auto[tmp];` +
    `[tmp][1:v] overlay=W-w-20:20:format=auto`,
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

// Função para animar rodapé aparecendo e desaparecendo entre 6 e 7 minutos (360 a 420 seg)
async function animarRodapeNoTempo(input, output, rodapeFade, tempoInsercao) {
  const entrada = tempoInsercao;
  const fim = tempoInsercao + 60;

  // expressão de y para o overlay animado (entrando e saindo)
  const overlayExpr = `'if(lt(t,${entrada + 1}), H - (t - ${entrada})*100, if(lt(t,${fim - 1}), H - 100, H - 100 + (t - ${fim - 1})*100))'`;

  await executarFFmpeg([
    '-i', input,
    '-i', rodapeFade,
    '-filter_complex',
    `[0:v][1:v] overlay=0:${overlayExpr}:enable='between(t,${entrada},${fim})'[v];` +
    `[0:a]anull[a]`,
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

    const camposObrigatorios = [
      'id',
      'video_principal',
      'logo_id',
      'rodape_id',
      'video_inicial',
      'video_miraplay',
      'video_final',
    ];

    const camposVazios = camposObrigatorios.filter(campo => !dados[campo]);
    if (camposVazios.length > 0) {
      console.log('❌ Campos obrigatórios vazios ou ausentes:', camposVazios);
      throw new Error('❌ input.json está incompleto. Corrija os campos acima.');
    }

    const {
      video_principal,
      stream_url,
      id,
      logo_id,
      rodape_id,
      rodape_texto,
      videos_extras = [],
      video_inicial,
      video_miraplay,
      video_final
    } = dados;

    await baixarArquivo(rodape_id, 'footer.png', auth);

    if (rodape_texto) {
      await gerarImagemTexto(rodape_texto);
    } else {
      console.log('⚠️ rodape_texto ausente, gerando imagem transparente.');
      await executarFFmpeg(['-f', 'lavfi', '-i', 'color=c=0x00000000:s=640x100', '-frames:v', '1', 'texto.png']);
      registrarTemporario('texto.png');
    }

    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);

    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');

    await aplicarRodapeELogo('parte1_re.mp4', 'parte1_final_temp.mp4', 'footer.png', 'logo.png');
    await aplicarRodapeELogo('parte2_re.mp4', 'parte2_final_temp.mp4', 'footer.png', 'logo.png');

    // Rodapé animado aparece entre 6 e 7 minutos (360-420s)
    await animarRodapeNoTempo('parte1_final_temp.mp4', 'parte1_final.mp4', 'rodape_fade.mp4', 360);
    await animarRodapeNoTempo('parte2_final_temp.mp4', 'parte2_final.mp4', 'rodape_fade.mp4', 360);

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

      // Se for arquivo local mp4, usa direto
      if (idVideo.endsWith('.mp4') && fs.existsSync(idVideo)) {
        arquivosProntos.push(idVideo);
        continue;
      }

      await baixarArquivo(idVideo, raw, auth);
      await reencode(raw, final);
      arquivosProntos.push(final);
    }

    await unirVideos(arquivosProntos, 'video_final_completo.mp4');

    fs.writeFileSync('stream_info.json', JSON.stringify({ stream_url, video_id: id }, null, 2));
    console.log('🎉 Finalizado com sucesso! Vídeo: video_final_completo.mp4');

  } catch (err) {
    console.error('🚨 ERRO:', err.message);
    limparTemporarios();
    process.exit(1);
  }
})();
