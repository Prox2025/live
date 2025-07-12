const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

const arquivosTemporarios = [];

function registrarTemporario(caminho) {
  arquivosTemporarios.push(caminho);
}

function executarFFmpeg(args, output) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    ffmpeg.stderr.on('data', (data) => process.stderr.write(data));
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        if (output) console.log(`✅ Criado: ${output}`);
        resolve();
      } else {
        reject(new Error(`FFmpeg falhou com código ${code}`));
      }
    });
  });
}

async function autenticar() {
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  return await auth.getClient();
}

async function baixarArquivo(id, destino, auth) {
  if (!id) throw new Error(`❌ ID ausente para ${destino}`);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destino);
    res.data.pipe(out);
    res.data.on('end', () => {
      registrarTemporario(destino);
      console.log(`📥 Baixado: ${destino}`);
      resolve();
    });
    res.data.on('error', reject);
  });
}

async function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video]);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('close', () => resolve(parseFloat(data.trim())));
    ffprobe.on('error', reject);
  });
}

async function cortarTrecho(input, inicio, duracao, output) {
  await executarFFmpeg([
    '-i', input,
    '-ss', inicio.toString(),
    '-t', duracao.toString(),
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-b:a', '128k',
    output
  ], output);
}

async function aplicarLogo(input, output) {
  if (!fs.existsSync('logo.png')) {
    fs.copyFileSync(input, output);
    return;
  }

  await executarFFmpeg([
    '-i', input,
    '-i', 'logo.png',
    '-filter_complex',
    '[1:v]scale=70:70[logo];[0:v][logo]overlay=W-w-10:10',
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-b:a', '128k',
    output
  ], output);
}

async function inserirRodape(video, rodape, saida, tempoRodape, pontoInsercao) {
  const antes = saida + '_antes.mp4';
  const depois = saida + '_depois.mp4';
  const reduzido = saida + '_reduzido.mp4';
  const combinado = saida + '_combinado.mp4';

  await cortarTrecho(video, 0, pontoInsercao, antes);
  await cortarTrecho(video, pontoInsercao + tempoRodape, 9999, depois);

  await executarFFmpeg([
    '-i', video,
    '-vf', 'scale=480:270',
    '-t', tempoRodape.toString(),
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-an',
    reduzido
  ], reduzido);

  await executarFFmpeg([
    '-i', rodape,
    '-i', reduzido,
    '-filter_complex',
    '[0:v][1:v]overlay=(W-w)/2:(H-h)/2',
    '-t', tempoRodape.toString(),
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '20',
    '-an',
    combinado
  ], combinado);

  const listaConcat = saida + '_lista.txt';
  fs.writeFileSync(listaConcat, `file '${path.resolve(antes)}'\nfile '${path.resolve(combinado)}'\nfile '${path.resolve(depois)}'\n`);
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', listaConcat, '-c', 'copy', saida], saida);
}

async function unirFinal(arquivos, saida) {
  const lista = 'lista_final.txt';
  fs.writeFileSync(lista, arquivos.map(p => `file '${path.resolve(p)}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', saida], saida);
}

async function main() {
  const input = JSON.parse(fs.readFileSync('input.json'));
  const auth = await autenticar();

  // Baixar rodapé
  await baixarArquivo(input.rodape_id, 'rodape.mp4', auth);
  const durRodape = await obterDuracao('rodape.mp4');

  const ordem = [];

  // Baixar vídeos fixos: inicial, miraplay, final
  const fixos = [
    { id: input.video_inicial, nome: 'inicial.mp4' },
    { id: input.video_miraplay, nome: 'miraplay.mp4' },
    { id: input.video_final, nome: 'final.mp4' }
  ];

  for (const f of fixos) {
    await baixarArquivo(f.id, f.nome, auth);
    const comLogo = f.nome.replace('.mp4', '_logo.mp4');
    await aplicarLogo(f.nome, comLogo);
    ordem.push(comLogo);
  }

  // Parte 1 com rodapé
  await baixarArquivo(input.video_principal, 'principal.mp4', auth);
  const duracaoPrincipal = await obterDuracao('principal.mp4');
  const metade = duracaoPrincipal / 2;

  await cortarTrecho('principal.mp4', 0, metade, 'parte1.mp4');
  await inserirRodape('parte1.mp4', 'rodape.mp4', 'parte1_final.mp4', durRodape, 240);
  await aplicarLogo('parte1_final.mp4', 'parte1_logo.mp4');
  ordem.splice(1, 0, 'parte1_logo.mp4'); // após inicial

  // Vídeos extras
  for (let i = 0; i < input.videos_extras.length; i++) {
    const id = input.videos_extras[i];
    const nome = `extra_${i}.mp4`;
    await baixarArquivo(id, nome, auth);
    ordem.push(nome);
  }

  // Parte 2 com rodapé
  await cortarTrecho('principal.mp4', metade, duracaoPrincipal - metade, 'parte2.mp4');
  await inserirRodape('parte2.mp4', 'rodape.mp4', 'parte2_final.mp4', durRodape, 240);
  await aplicarLogo('parte2_final.mp4', 'parte2_logo.mp4');
  ordem.push('parte2_logo.mp4');

  // Unir vídeo final
  await unirFinal(ordem, 'video_final_completo.mp4');

  const stats = fs.statSync('video_final_completo.mp4');
  const duracao = await obterDuracao('video_final_completo.mp4');
  const tamanho = (stats.size / (1024 * 1024)).toFixed(2);

  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id,
    stream_url: input.stream_url,
    duracao,
    tamanho_mb: tamanho
  }, null, 2));

  console.log(`✅ Vídeo final pronto: video_final_completo.mp4`);
  console.log(`⏱️  Duração total: ${duracao.toFixed(2)} segundos`);
  console.log(`💾 Tamanho final: ${tamanho} MB`);
}

main().catch(console.error);
