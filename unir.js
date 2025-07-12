// montar_video_com_rodape.js
// IMPORTAÇÕES
const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const path = require('path');

// CONFIGURAÇÃO
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

async function cortarTrechoComFFmpeg(input, inicio, duracao, output) {
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

async function inserirRodape(videoParte, rodape, saida, duracaoRodape, pontoInsercao) {
  const antes = `${saida}_pre.mp4`;
  const depois = `${saida}_post.mp4`;
  const parteReduzida = `${saida}_reduzido.mp4`;
  const combinado = `${saida}_rodape.mp4`;

  // Cortar antes e depois do ponto de inserção
  await cortarTrechoComFFmpeg(videoParte, 0, pontoInsercao, antes);
  await cortarTrechoComFFmpeg(videoParte, pontoInsercao + duracaoRodape, 9999, depois);

  // Reduzir o vídeo original para caber no fundo branco do rodapé
  await executarFFmpeg([
    '-i', videoParte,
    '-vf', 'scale=480:270',
    '-t', duracaoRodape.toString(),
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-an',
    parteReduzida
  ], parteReduzida);

  // Combinar rodapé com o vídeo reduzido sobreposto
  await executarFFmpeg([
    '-i', rodape,
    '-i', parteReduzida,
    '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2',
    '-t', duracaoRodape.toString(),
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '20',
    '-an',
    combinado
  ], combinado);

  // Juntar tudo: antes + combinado + depois
  const lista = `${saida}_lista.txt`;
  fs.writeFileSync(lista, `file '${path.resolve(antes)}'\nfile '${path.resolve(combinado)}'\nfile '${path.resolve(depois)}'\n`);
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', saida], saida);
}

async function unirFinal(lista, saida) {
  const listaTxt = 'inputs_final.txt';
  fs.writeFileSync(listaTxt, lista.map(f => `file '${path.resolve(f)}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', listaTxt, '-c', 'copy', saida], saida);
}

async function main() {
  const input = JSON.parse(fs.readFileSync(inputFile));
  const auth = await autenticar();

  // Baixar rodapé
  await baixarArquivo(input.rodape_id, 'rodape.mp4', auth);
  const duracaoRodape = await obterDuracao('rodape.mp4');

  // Baixar partes e inserir rodapé
  await baixarArquivo(input.parte1_id, 'parte1.mp4', auth);
  await inserirRodape('parte1.mp4', 'rodape.mp4', 'parte1_final.mp4', duracaoRodape, 240);

  await baixarArquivo(input.parte2_id, 'parte2.mp4', auth);
  await inserirRodape('parte2.mp4', 'rodape.mp4', 'parte2_final.mp4', duracaoRodape, 240);

  // Montar vídeo final
  const ordem = ['parte1_final.mp4', 'parte2_final.mp4'];
  await unirFinal(ordem, 'video_final_completo.mp4');

  // Info final
  const stats = fs.statSync('video_final_completo.mp4');
  const duracaoFinal = await obterDuracao('video_final_completo.mp4');
  const tamanhoMB = (stats.size / (1024 * 1024)).toFixed(2);

  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id,
    stream_url: input.stream_url || null,
    duracao: duracaoFinal,
    tamanho_mb: tamanhoMB,
    criado_em: new Date().toISOString()
  }, null, 2));

  console.log(`✅ Vídeo final: video_final_completo.mp4`);
  console.log(`⏱️ Duração: ${duracaoFinal.toFixed(2)}s`);
  console.log(`💾 Tamanho: ${tamanhoMB} MB`);
}

main().catch(console.error);
