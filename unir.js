const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const path = require('path');

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

async function gerarImagemTexto(texto) {
  console.log(`🖊️ Gerando imagem com texto: "${texto}"`);
  const pathTxt = 'descricao.txt';
  fs.writeFileSync(pathTxt, texto);
  registrarTemporario(pathTxt);
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=c=0x00000000:s=600x80',
    '-vf', `drawtext=textfile=${pathTxt}:fontcolor=white:fontsize=24:x=10:y=10`,
    '-frames:v', '1',
    'texto.png'
  ]);
  registrarTemporario('texto.png');
}

async function aplicarRodapeELogo(input, output, rodape, logo, delaySec = 360) {
  if (!fs.existsSync(rodape)) throw new Error(`❌ Rodapé não encontrado: ${rodape}`);
  if (!fs.existsSync(logo)) throw new Error(`❌ Logo não encontrado: ${logo}`);
  if (!fs.existsSync('texto.png')) throw new Error('❌ texto.png não encontrado');

  console.log(`🎨 Aplicando rodapé e logo ao vídeo: ${input}`);

  const rodapeComFade = 'rodape_fade.mp4';
  registrarTemporario(rodapeComFade);

  await executarFFmpeg([
    '-loop', '1',
    '-i', rodape,
    '-i', 'texto.png',
    '-filter_complex',
    `[0:v][1:v]hstack=inputs=2,format=rgba,fps=30,fade=t=in:st=${delaySec}:d=5:alpha=1,fade=t=out:st=${delaySec + 35}:d=5:alpha=1`,
    '-t', '600',
    '-c:v', 'qtrle',
    rodapeComFade
  ]);

  await executarFFmpeg([
    '-i', input,
    '-i', logo,
    '-i', rodapeComFade,
    '-filter_complex',
    `[0:v][2:v]overlay=x=0:y=main_h-overlay_h:format=auto[tmp];[tmp][1:v]overlay=W-w-10:10:format=auto`,
    '-c:a', 'copy',
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

    // === Verificações obrigatórias
    if (!id || !video_principal || !logo_id || !rodape_id || !video_inicial || !video_miraplay || !video_final) {
      throw new Error('❌ input.json está incompleto. Verifique os campos obrigatórios.');
    }

    console.log('✅ Todos os campos obrigatórios presentes.');

    // === Baixar rodapé
    await baixarArquivo(rodape_id, 'footer.png', auth);

    // === Texto (opcional)
    if (rodape_texto) {
      await gerarImagemTexto(rodape_texto);
    } else {
      console.log('⚠️ rodape_texto ausente. Gerando imagem transparente.');
      await executarFFmpeg(['-f', 'lavfi', '-i', 'color=c=0x00000000:s=600x80', '-frames:v', '1', 'texto.png']);
      registrarTemporario('texto.png');
    }

    // === Baixar logo
    await baixarArquivo(logo_id, 'logo.png', auth);

    // === Baixar vídeo principal
    await baixarArquivo(video_principal, 'principal.mp4', auth);
    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    // === Dividir e reencodar vídeo principal
    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');

    await aplicarRodapeELogo('parte1_re.mp4', 'parte1_final.mp4', 'footer.png', 'logo.png');
    await aplicarRodapeELogo('parte2_re.mp4', 'parte2_final.mp4', 'footer.png', 'logo.png');

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
      const id = videoIds[i];
      if (!id) continue;

      const raw = `video_${i}_raw.mp4`;
      const final = `video_${i}.mp4`;

      if (id.endsWith('.mp4') && fs.existsSync(id)) {
        arquivosProntos.push(id);
        continue;
      }

      await baixarArquivo(id, raw, auth);
      await reencode(raw, final);
      arquivosProntos.push(final);
    }

    await unirVideos(arquivosProntos, 'video_final_completo.mp4');

    fs.writeFileSync('stream_info.json', JSON.stringify({ stream_url, video_id: id }, null, 2));
    console.log('🎉 Finalizado com sucesso! 🎬 Vídeo final: video_final_completo.mp4');
  } catch (err) {
    console.error('🚨 ERRO:', err.message);
    limparTemporarios();
    process.exit(1);
  }
})();
