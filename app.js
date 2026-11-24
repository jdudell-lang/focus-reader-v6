import * as pdfjs from './vendor/pdfjs/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/pdf.worker.min.mjs',import.meta.url).href;
const $=id=>document.getElementById(id);let sentences=[],position=0,chapters=[],bookId='',bookTitle='',installPrompt=null,prevPressed=false,nextPressed=false,testing=false;
let pageStarts=[0],sourceSentences=[],segmentStarts=[],sourcePageStarts=[0],sourceKinds=[],segmentKinds=[],glossary={},mode='reading',selectedWord=0,selectedTerm=0,definitionTerm='',definitionText='',definitionReturn='words',padPressed={};
const dbp=new Promise((resolve,reject)=>{let req=indexedDB.open('focus-reader',1);req.onupgradeneeded=()=>req.result.createObjectStore('books',{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
async function store(mode='readonly'){let db=await dbp;return db.transaction('books',mode).objectStore('books')}
async function allBooks(){let s=await store();return new Promise(r=>{let q=s.getAll();q.onsuccess=()=>r(q.result)})}
async function putBook(b){let s=await store('readwrite');return new Promise((r,j)=>{let q=s.put(b);q.onsuccess=r;q.onerror=j})}
async function getBook(id){let s=await store();return new Promise((r,j)=>{let q=s.get(id);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})}
async function removeBook(id){let s=await store('readwrite');return new Promise((r,j)=>{let q=s.delete(id);q.onsuccess=r;q.onerror=()=>j(q.error)})}
const prefsKey='focus-reader-v4-prefs';const lastBookKey='focus-reader-last-book';
function preferences(){try{return JSON.parse(localStorage.getItem(prefsKey)||'{}')}catch{return {}}}
function savePreferences(){localStorage.setItem(prefsKey,JSON.stringify({charLength:$('charLength').value,dim:$('dim').value,fontSize:$('fontSize').value,lineSpacing:$('lineSpacing').value}));localStorage.setItem('focus-reader-settings-dirty','1');queueCloudSync()}
function applyPreferences(){const p=preferences();for(const id of ['charLength','dim','fontSize','lineSpacing'])if(p[id]!==undefined)$(id).value=p[id];document.documentElement.style.setProperty('--dim',String(+$('dim').value/100));document.documentElement.style.setProperty('--reader-font',$('fontSize').value+'px');document.documentElement.style.setProperty('--reader-line',$('lineSpacing').value);$('charLengthValue').textContent=$('charLength').value+' characters';$('fontSizeValue').textContent=$('fontSize').value+'px';$('lineSpacingValue').textContent=$('lineSpacing').value;}
function wordTokens(text){return text.trim().match(/\S+/g)||[]}
function buildSegments(source, target){
  const parts=[],starts=[],kinds=[];
  const limit=Math.max(50,Math.min(300,Number(target)||150));
  let globalWords=0;
  source.forEach((paragraph,block)=>{
    const tokens=wordTokens(paragraph);
    const heading=sourceKinds[block]==='heading';
    for(let i=0;i<tokens.length;){
      let j=i,chars=0;
      while(j<tokens.length&&(j===i||chars+tokens[j].length+1<=limit)){
        chars+=tokens[j].length+(j>i?1:0);j++;
      }
      if(!heading&&j<tokens.length){
        for(let k=j;k>Math.max(i+1,j-5);k--){
          if(/[.!?;:]$/.test(tokens[k-1])&&chars-(j-k)*5>=limit*.7){j=k;break}
        }
      }
      starts.push(globalWords+i);parts.push(tokens.slice(i,j).join(' '));kinds.push({block,heading});i=j;
    }
    globalWords+=tokens.length;
  });
  return {parts,starts,kinds};
}
function segmentAtWord(word){
  let lo=0,hi=segmentStarts.length-1;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(segmentStarts[mid]<=word)lo=mid;else hi=mid-1}
  return lo;
}
function rebuildSegments(wordPosition=0){
  const built=buildSegments(sourceSentences,$('charLength').value);
  sentences=built.parts;segmentStarts=built.starts;segmentKinds=built.kinds;
  position=sentences.length?segmentAtWord(wordPosition):0;
  const prefix=[0];for(const part of sourceSentences)prefix.push(prefix.at(-1)+wordTokens(part).length);
  pageStarts=sourcePageStarts.map(i=>segmentAtWord(prefix[Math.min(prefix.length-1,Math.max(0,i))]||0));
  render();
}
function currentWordOffset(){return segmentStarts[position]||0}
function status(t){$('status').textContent=t}
function splitText(text){return (text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)||[]).map(s=>s.trim()).filter(s=>s.length>1)}
async function importPdf(file,opts={}){
 status('Extracting textbook text and layout…');
 try{
  const bytes=await file.arrayBuffer();
  const pdf=await pdfjs.getDocument({data:new Uint8Array(bytes.slice(0))}).promise;
  const blocks=[],kinds=[],starts=[],pageBlockStarts=[];
  for(let p=1;p<=pdf.numPages;p++){
    pageBlockStarts.push(blocks.length);
    const page=await pdf.getPage(p);
    const content=await page.getTextContent();
    const lines=[];let current=null;
    for(const item of content.items){
      if(!item.str?.trim())continue;
      const y=item.transform?.[5]??0,x=item.transform?.[4]??0;
      const height=Math.abs(item.height||item.transform?.[3]||12);
      if(!current||Math.abs(current.y-y)>Math.max(2,height*.33)){
        current={y,x,height,text:item.str.trim()};lines.push(current);
      }else{
        current.text+=(item.str.startsWith(' ')?'':' ')+item.str.trim();
        current.height=Math.max(current.height,height);
      }
    }
    let para='',prev=null,paraHeight=0;
    function flush(){
      if(!para.trim())return;
      const t=para.trim();
      const heading= t.length<105&&(/^(chapter\s+\d+|section\s+\d+|\d+(?:\.\d+){0,3}\s+\S)/i.test(t)||(/^[A-Z\d\s,:–—-]+$/.test(t)&&t.length>5));
      if(heading)starts.push({label:t.slice(0,85),offset:blocks.length});
      blocks.push(t);kinds.push(heading?'heading':'paragraph');para='';paraHeight=0;
    }
    for(const ln of lines){
      if(!ln.text.trim())continue;
      const gap=prev?Math.abs(prev.y-ln.y):0;
      const newPara=prev&&(gap>Math.max(prev.height,ln.height)*1.6||Math.abs(ln.x-prev.x)>30||/^[•▪◦\-]\s/.test(ln.text)||/^(Chapter|Section)\s+\d+/i.test(ln.text));
      if(newPara)flush();
      para+=(para?' ':'')+ln.text.trim();paraHeight=Math.max(paraHeight,ln.height);prev=ln;
    }
    flush();
  }
  if(blocks.join(' ').length<50)throw Error('No readable text found. This may be a scanned PDF.');
  const id=opts.bookId||file.name+'-'+file.size,existing=await getBook(id);
  const book={id,title:file.name,sentences:blocks,kinds,position:existing?.position||0,wordOffset:existing?.wordOffset,chapters:starts,pageStarts:pageBlockStarts,glossary:existing?.glossary||{},pdfData:new Uint8Array(bytes)};
  book.syncDirty=!opts.fromCloud;book.localUpdatedAt=Date.now();await putBook(book);if(!opts.fromCloud)queueCloudSync();await refreshLibrary();if(!opts.silent)await openBook(id);
  status('Imported '+blocks.length+' text blocks across '+pdf.numPages+' pages. Layout is approximate; original pages are available.');
 }catch(e){status('Import failed: '+e.message)}
}
async function openBook(id){let b=await getBook(id);if(!b)return;bookId=b.id;bookTitle=b.title;sourceSentences=b.sentences;sourceKinds=b.kinds||[];chapters=b.chapters||[];sourcePageStarts=b.pageStarts||[0];glossary=b.glossary||{};closeModes();localStorage.setItem(lastBookKey,id);$('empty').hidden=true;const prefix=sourceSentences.slice(0,b.position||0).reduce((sum,x)=>sum+wordTokens(x).length,0);rebuildSegments(b.wordOffset??prefix);scheduleRestoreScroll();await refreshLibrary();}
function currentChapter(){let index=0;for(let i=0;i<chapters.length;i++){if(chapters[i].offset<=position*8)index=i}return index}
function render(){
 const area=$('reading');area.replaceChildren();let lastBlock=-1,container=null;
 sentences.forEach((part,i)=>{
   const info=segmentKinds[i]||{block:0,heading:false};
   if(info.block!==lastBlock){
     container=document.createElement(info.heading?'h2':'p');
     container.className=info.heading?'readerHeading':'readerParagraph';
     area.append(container);lastBlock=info.block;
   }
   const span=document.createElement('span');span.className='sentence';span.dataset.index=i;
   span.textContent=part+' ';container.append(span);
 });update(false);
}
function update(scroll=true){if(!sentences.length)return;let n=1;document.querySelectorAll('.sentence').forEach((e,i)=>{e.classList.toggle('active',i>=position&&i<position+n);e.classList.toggle('near',i>=position-3&&i<position+n+3&&!(i>=position&&i<position+n))});let p=Math.min(100,Math.round((position+n)/sentences.length*100));$('bookPct').textContent=p+'%';$('bookBar').style.width=p+'%';let c=currentChapter(),from=chapters[c]?.offset||0,to=chapters[c+1]?.offset||sentences.length*8;let approximateStart=Math.floor(from/8),approximateEnd=Math.max(approximateStart+1,Math.floor(to/8));let cp=Math.min(100,Math.max(0,Math.round((position-approximateStart+n)/(approximateEnd-approximateStart)*100)));$('chapterLabel').textContent=chapters[c]?.label||'Whole book (chapter headings not detected)';$('chapterPct').textContent=cp+'%';$('chapterBar').style.width=cp+'%';if(scroll)scrollToActive('smooth');savePosition();updateLibraryProgress()}
// Position the first highlighted sentence just beneath the sticky progress header.
// Use document coordinates instead of scrollIntoView(center), which ignores the header.
function scrollToActive(behavior='auto'){
  const el=areaSentence(position);
  if(!el)return;
  const header=document.querySelector('header');
  const headerHeight=header?.getBoundingClientRect().height||0;
  const target=window.scrollY+el.getBoundingClientRect().top-headerHeight-12;
  window.scrollTo({top:Math.max(0,target),behavior});
}
// PDF render, font layout, orientation and viewport sizing may settle asynchronously.
// Repeat the alignment after layout to reliably restore the saved bookmark.
let restoreSequence=0;
function scheduleRestoreScroll(){
  const sequence=++restoreSequence;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(sequence!==restoreSequence)return;
    scrollToActive('auto');
    setTimeout(()=>{if(sequence===restoreSequence)scrollToActive('auto')},180);
    setTimeout(()=>{if(sequence===restoreSequence)scrollToActive('auto')},550);
  }));
}
function areaSentence(i){return document.querySelector(`.sentence[data-index="${i}"]`)}
let saveTimer;function savePosition(){clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{if(!bookId)return;let b=await getBook(bookId);if(b){b.position=sourceIndexAtWord(currentWordOffset());b.wordOffset=currentWordOffset();b.syncDirty=true;b.localUpdatedAt=Date.now();await putBook(b);queueCloudSync()}},250)}
function sourceIndexAtWord(word){
  let total=0;for(let i=0;i<sourceSentences.length;i++){total+=wordTokens(sourceSentences[i]).length;if(total>word)return i}
  return Math.max(0,sourceSentences.length-1);
}
function move(delta){if(mode!=='reading')return;if(!sentences.length)return;position=Math.max(0,Math.min(sentences.length-1,position+delta));update()}

function jumpPage(delta){if(!sentences.length)return;let page=0;for(let i=0;i<pageStarts.length;i++)if(pageStarts[i]<=position)page=i;position=Math.max(0,Math.min(sentences.length-1,pageStarts[Math.max(0,Math.min(pageStarts.length-1,page+delta))]??position));update();status('PDF page '+(pageStarts.findIndex((v,i)=>i===page+delta)+1||'navigation')+' (approximate text boundary)')}
let pdfViewDoc=null,pdfViewPage=1;
async function showOriginalPage(){
 if(!bookId)return;
 const book=await getBook(bookId);
 if(!book?.pdfData){status('Original PDF not saved for this book. Re-import the PDF to enable original-page viewing.');return}
 try{
  if(!pdfViewDoc||pdfViewDoc.bookId!==bookId){
   pdfViewDoc=await pdfjs.getDocument({data:new Uint8Array(book.pdfData)}).promise;
   pdfViewDoc.bookId=bookId;
  }
  let page=0;for(let i=0;i<pageStarts.length;i++)if(pageStarts[i]<=position)page=i;
  pdfViewPage=Math.min(pdfViewDoc.numPages,page+1);
  $('originalPanel').hidden=false;await renderOriginalPage();
 }catch(e){status('Could not open original PDF: '+e.message)}
}
async function renderOriginalPage(){
 const page=await pdfViewDoc.getPage(pdfViewPage);
 const canvas=$('originalCanvas'),ctx=canvas.getContext('2d');
 const base=page.getViewport({scale:1});
 const width=Math.max(240,Math.min(1400,window.innerWidth*.88));
 const viewport=page.getViewport({scale:width/base.width});
 canvas.width=Math.round(viewport.width);canvas.height=Math.round(viewport.height);
 await page.render({canvasContext:ctx,viewport}).promise;
 $('originalPageLabel').textContent='PDF page '+pdfViewPage+' of '+pdfViewDoc.numPages;
}
$('originalOpen').onclick=showOriginalPage;
$('originalClose').onclick=()=>{$('originalPanel').hidden=true};
$('originalPrev').onclick=async()=>{if(pdfViewDoc){pdfViewPage=Math.max(1,pdfViewPage-1);await renderOriginalPage()}};
$('originalNext').onclick=async()=>{if(pdfViewDoc){pdfViewPage=Math.min(pdfViewDoc.numPages,pdfViewPage+1);await renderOriginalPage()}};
function closeModes(){mode='reading';$('wordPanel').hidden=true;$('glossaryPanel').hidden=true;$('definitionPanel').hidden=true;document.body.classList.remove('word-mode')}
function wordsInFocus(){return sentences.slice(position,position+1).join(' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)||[]}
function showWords(){if(!sentences.length)return;mode='words';selectedWord=0;$('wordPanel').hidden=false;$('glossaryPanel').hidden=true;$('definitionPanel').hidden=true;drawWords()}
function drawWords(){const root=$('wordChoices');root.replaceChildren();wordsInFocus().forEach((w,i)=>{let b=document.createElement('button');b.textContent=w;b.className='wordChoice'+(i===selectedWord?' chosen':'');b.onclick=()=>{selectedWord=i;lookupWord()};root.append(b)});root.children[selectedWord]?.scrollIntoView({block:'nearest',inline:'nearest'});$('wordHelp').textContent='D-pad: choose word · A: definition · Y: glossary · B: cancel'}
function moveWord(dx,dy){let words=wordsInFocus();if(!words.length)return;selectedWord=Math.max(0,Math.min(words.length-1,selectedWord+(dx||dy*5)));drawWords()}
const builtins={cuneiform:'An ancient writing system using wedge-shaped marks.',dynasty:'A succession of rulers from the same family.',empire:'A state governing multiple territories or peoples.',civilization:'A complex society with cities, institutions, and cultural traditions.',mesopotamia:'A historical region between the Tigris and Euphrates rivers.',city:'A large permanent human settlement.'};
async function lookupWord(){let word=wordsInFocus()[selectedWord];if(!word)return;definitionReturn='words';await openDefinition(word)}
async function openDefinition(word){definitionTerm=word;mode='definition';$('wordPanel').hidden=true;$('glossaryPanel').hidden=true;$('definitionPanel').hidden=false;$('definitionTitle').textContent=word;$('definitionBody').textContent=glossary[word.toLowerCase()]||builtins[word.toLowerCase()]||'Looking up definition… (internet required for new words)';if(glossary[word.toLowerCase()]||builtins[word.toLowerCase()])return;try{let controller=new AbortController();let timeout=setTimeout(()=>controller.abort(),5500);let response=await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/'+encodeURIComponent(word),{signal:controller.signal});clearTimeout(timeout);if(!response.ok)throw Error('No entry');let data=await response.json();let meaning=data[0]?.meanings?.[0]?.definitions?.[0]?.definition;if(!meaning)throw Error('No entry');if(mode==='definition'&&definitionTerm===word)$('definitionBody').textContent=meaning}catch{if(mode==='definition'&&definitionTerm===word)$('definitionBody').textContent='No offline definition available. Connect to the internet or add a custom definition.'}}
async function saveGlossary(){let word=definitionTerm.toLowerCase();let val=$('definitionBody').textContent;if(val.startsWith('Looking up')||val.startsWith('No offline')){val=prompt('Enter a definition for '+definitionTerm+':')||''}if(!val)return;glossary[word]=val;let b=await getBook(bookId);if(b){b.glossary=glossary;b.syncDirty=true;b.localUpdatedAt=Date.now();await putBook(b);queueCloudSync()}$('definitionBody').textContent=val;status('Saved '+definitionTerm+' to glossary')}
function showGlossary(){if(!sentences.length)return;if(mode==='glossary'){closeModes();return}mode='glossary';selectedTerm=0;$('wordPanel').hidden=true;$('definitionPanel').hidden=true;$('glossaryPanel').hidden=false;drawGlossary()}
function drawGlossary(){let entries=Object.entries(glossary).sort(([a],[b])=>a.localeCompare(b));let root=$('glossaryEntries');root.replaceChildren();if(!entries.length){root.textContent='No saved words yet. Select a word using the D-pad and press A, then Save to glossary.';return}selectedTerm=Math.max(0,Math.min(entries.length-1,selectedTerm));entries.forEach(([word,def],i)=>{let b=document.createElement('button');b.className='glossaryEntry'+(i===selectedTerm?' chosen':'');b.textContent=word;b.onclick=()=>{selectedTerm=i;definitionReturn='glossary';openDefinition(word)};root.append(b)});root.children[selectedTerm]?.scrollIntoView({block:'nearest'})}
function actionA(){if(mode==='reading')showWords();else if(mode==='words')lookupWord();else if(mode==='definition'){if(definitionReturn==='glossary'){showGlossary()}else{closeModes()}}else if(mode==='glossary'){let word=Object.keys(glossary).sort()[selectedTerm];if(word){definitionReturn='glossary';openDefinition(word)}}}
function actionY(){if(mode==='glossary'){closeModes()}else showGlossary()}
function actionB(){if(mode==='definition'&&definitionReturn==='glossary')showGlossary();else closeModes()}
function dpad(dir){if(mode==='reading'){showWords();return}if(mode==='words'){moveWord(dir==='left'?-1:dir==='right'?1:0,dir==='up'?-1:dir==='down'?1:0)}else if(mode==='glossary'){selectedTerm+=dir==='up'||dir==='left'?-1:1;drawGlossary()}}
$('pagePrev').onclick=()=>jumpPage(-1);$('pageNext').onclick=()=>jumpPage(1);$('glossaryToggle').onclick=actionY;$('selectWords').onclick=showWords;$('wordClose').onclick=closeModes;$('glossaryClose').onclick=closeModes;$('definitionClose').onclick=actionA;$('saveTerm').onclick=saveGlossary;
$('next').onclick=()=>move(1);$('prev').onclick=()=>move(-1);$('resume').onclick=()=>{if(sentences.length){scheduleRestoreScroll();status('Returned to your current saved reading position.')}else status('Open a book first.')};$('pdf').onchange=e=>{if(e.target.files[0])importPdf(e.target.files[0])};$('charLength').oninput=()=>{$('charLengthValue').textContent=$('charLength').value+' characters';savePreferences();if(sourceSentences.length){const word=currentWordOffset();rebuildSegments(word);scheduleRestoreScroll()}};$('fontSize').oninput=()=>{document.documentElement.style.setProperty('--reader-font',$('fontSize').value+'px');$('fontSizeValue').textContent=$('fontSize').value+'px';savePreferences();scheduleRestoreScroll()};$('lineSpacing').oninput=()=>{document.documentElement.style.setProperty('--reader-line',$('lineSpacing').value);$('lineSpacingValue').textContent=$('lineSpacing').value;savePreferences();scheduleRestoreScroll()};$('dim').oninput=()=>{document.documentElement.style.setProperty('--dim',String(+$('dim').value/100));savePreferences()};
window.addEventListener('keydown',e=>{if(e.key==='Escape'){actionB();return}if(mode!=='reading'){if(e.key==='Enter'){e.preventDefault();actionA()}else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();dpad(e.key.slice(5).toLowerCase())}else if(e.key.toLowerCase()==='y'){actionY()}return}if(e.key.toLowerCase()==='y'){actionY();return}if(e.key.toLowerCase()==='a'){actionA();return}if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();dpad('right');return}if(['ArrowRight','PageDown',' '].includes(e.key)){e.preventDefault();move(1)}else if(['ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();move(-1)}});
function pollGamepad(){let pads=navigator.getGamepads?.()||[];let p=Array.from(pads).find(Boolean);if(p){let left=!!p.buttons[6]?.pressed||p.buttons[6]?.value>.6,right=!!p.buttons[7]?.pressed||p.buttons[7]?.value>.6;if(testing)status('Controller: '+p.id+' | LT '+(p.buttons[6]?.value||0).toFixed(2)+' | RT '+(p.buttons[7]?.value||0).toFixed(2)+' | buttons '+p.buttons.map((b,i)=>b.pressed?i:'').filter(x=>x!=='').join(','));if(left&&!prevPressed)move(-1);if(right&&!nextPressed)move(1);prevPressed=left;nextPressed=right;const map={4:()=>jumpPage(-1),5:()=>jumpPage(1),0:actionA,3:actionY,1:actionB,12:()=>dpad('up'),13:()=>dpad('down'),14:()=>dpad('left'),15:()=>dpad('right')};for(let [key,fn] of Object.entries(map)){let pressed=!!p.buttons[Number(key)]?.pressed;if(pressed&&!padPressed[key])fn();padPressed[key]=pressed} }requestAnimationFrame(pollGamepad)}
$('test').onclick=()=>{testing=!testing;status(testing?'Press LT and RT; button values will appear here if Chrome exposes them.':'Controller test stopped.')};window.addEventListener('gamepadconnected',e=>status('Gamepad connected: '+e.gamepad.id));pollGamepad();
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('install').hidden=false});$('install').onclick=async()=>{if(installPrompt){installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('install').hidden=true}};
function updateLibraryProgress(){const row=document.querySelector('.bookRow.current');if(row){const meta=row.querySelector('.bookMeta'),fill=row.querySelector('.fill');const pct=Math.min(100,Math.round((position+1)/Math.max(1,sentences.length)*100));if(meta)meta.textContent=pct+'% read';if(fill)fill.style.width=pct+'%'}}
async function refreshLibrary(){let books=await allBooks();const root=$('library');root.replaceChildren();$('storageLabel').textContent=books.length+' book'+(books.length===1?'':'s');if(!books.length){const hint=document.createElement('small');hint.textContent='No books yet. Import a PDF to begin.';root.append(hint)}for(let b of books){const row=document.createElement('div');row.className='bookRow'+(b.id===bookId?' current':'');const left=document.createElement('div');const name=document.createElement('div');name.className='bookTitle';name.textContent=b.title;const pct=Math.min(100,Math.round((b.id===bookId?currentWordOffset():b.wordOffset??0)/Math.max(1,wordTokens((b.sentences||[]).join(' ')).length)*100));const meta=document.createElement('div');meta.className='bookMeta';meta.textContent=pct+'% read';const bar=document.createElement('div');bar.className='bar';const fill=document.createElement('div');fill.className='fill';fill.style.width=pct+'%';bar.append(fill);left.append(name,meta,bar);const actions=document.createElement('div');actions.className='bookActions';const open=document.createElement('button');open.type='button';open.textContent='Open';open.onclick=()=>openBook(b.id);const del=document.createElement('button');del.type='button';del.className='deleteBook';del.textContent='Delete';del.setAttribute('aria-label','Delete '+b.title);del.onclick=async()=>{if(!confirm('Delete "'+b.title+'" from this device? Its saved reading position will also be deleted. This cannot be undone unless you have a backup.'))return;await removeBook(b.id);if(b.id===bookId){bookId='';bookTitle='';sentences=[];sourceSentences=[];sourceKinds=[];segmentStarts=[];position=0;chapters=[];pageStarts=[0];sourcePageStarts=[0];glossary={};closeModes();$('reading').replaceChildren();$('empty').hidden=false;$('bookPct').textContent='0%';$('chapterPct').textContent='0%';$('bookBar').style.width='0%';$('chapterBar').style.width='0%';$('chapterLabel').textContent='Chapter progress';const remaining=await allBooks();if(remaining.length)await openBook(remaining[0].id);else localStorage.removeItem(lastBookKey)}await refreshLibrary();status('Book deleted from this device. Cloud copy remains available to restore on next sync.')};actions.append(open,del);row.append(left,actions);root.append(row)}return books}
function downloadJson(filename,data){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000)}
$('exportBackup').onclick=async()=>{try{const books=await allBooks();downloadJson('focus-reader-backup-'+new Date().toISOString().slice(0,10)+'.json',{format:'focus-reader-backup',version:4,createdAt:new Date().toISOString(),books,preferences:preferences(),lastBookId:bookId||localStorage.getItem(lastBookKey)});status('Reading backup exported. Keep this file private; it includes your extracted book text.')}catch(e){status('Backup export failed: '+e.message)}};
$('importBackup').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>60*1024*1024)throw Error('Backup exceeds 60 MB');const data=JSON.parse(await file.text());if(data.format!=='focus-reader-backup'||!Array.isArray(data.books)||data.books.length>500)throw Error('Not a valid Focus Reader backup');for(const b of data.books){if(typeof b.id!=='string'||typeof b.title!=='string'||!Array.isArray(b.sentences)||b.sentences.some(s=>typeof s!=='string')||b.sentences.length>200000)throw Error('Backup contains invalid book data')}if(!confirm('Import '+data.books.length+' book(s)? Matching book IDs will be replaced, including their saved reading positions. Other books will be kept.'))return;for(const b of data.books)await putBook({id:b.id,title:b.title,sentences:b.sentences,kinds:Array.isArray(b.kinds)?b.kinds:[],position:Math.max(0,Math.min(b.sentences.length-1,Number(b.position)||0)),chapters:Array.isArray(b.chapters)?b.chapters:[],pageStarts:Array.isArray(b.pageStarts)?b.pageStarts:[0],glossary:b.glossary&&typeof b.glossary==='object'?b.glossary:{},wordOffset:Number.isFinite(b.wordOffset)?b.wordOffset:undefined});if(data.preferences&&typeof data.preferences==='object'){const safe={};for(const k of ['charLength','dim','fontSize','lineSpacing'])if(data.preferences[k]!==undefined)safe[k]=String(data.preferences[k]);localStorage.setItem(prefsKey,JSON.stringify(safe));applyPreferences()}const books=await refreshLibrary();const chosen=books.find(b=>b.id===data.lastBookId)?.id||books[0]?.id;if(chosen)await openBook(chosen);status('Backup imported: '+data.books.length+' book(s).')}catch(err){status('Backup import failed: '+err.message)}finally{e.target.value=''}};
async function init(){applyPreferences();const books=await refreshLibrary();const id=localStorage.getItem(lastBookKey);if(books.length)await openBook(books.find(b=>b.id===id)?.id||books[0].id);if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});}init();

// Landscape settings drawer. Progress stays visible while the main toolbar is hidden.
const settingsToggle=document.getElementById('settingsToggle');
settingsToggle.addEventListener('click',()=>{const expanded=document.body.classList.toggle('show-settings');settingsToggle.setAttribute('aria-expanded',String(expanded));settingsToggle.textContent=expanded?'✕ Close':'⚙ Settings';});
window.matchMedia('(orientation: portrait)').addEventListener('change',e=>{if(e.matches){document.body.classList.remove('show-settings');settingsToggle.setAttribute('aria-expanded','false');settingsToggle.textContent='⚙ Settings';}});

window.addEventListener('orientationchange',()=>setTimeout(()=>{if(sentences.length)scrollToActive('auto')},350));
window.addEventListener('pageshow',()=>{if(sentences.length)scheduleRestoreScroll()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&sentences.length)scheduleRestoreScroll()});


/* Faster settings controls */

// Character length: rebuild only when released.
$('charLength').oninput = () => {
  $('charLengthValue').textContent =
    $('charLength').value + ' characters';
};

$('charLength').onchange = () => {
  savePreferences();
  if (sourceSentences.length) {
    const word = currentWordOffset();
    rebuildSegments(word);
    scheduleRestoreScroll();
  }
};

// Font size: don't scroll while dragging.
$('fontSize').oninput = () => {
  document.documentElement.style.setProperty(
    '--reader-font',
    $('fontSize').value + 'px'
  );
  $('fontSizeValue').textContent =
    $('fontSize').value + 'px';
  savePreferences();
};

$('fontSize').onchange = () => {
  if (sentences.length) scheduleRestoreScroll();
};

// Line spacing: don't scroll while dragging.
$('lineSpacing').oninput = () => {
  document.documentElement.style.setProperty(
    '--reader-line',
    $('lineSpacing').value
  );
  $('lineSpacingValue').textContent =
    $('lineSpacing').value;
  savePreferences();
};

$('lineSpacing').onchange = () => {
  if (sentences.length) scheduleRestoreScroll();
};


/* Faster RT / LT navigation */

// Update only the previously and newly highlighted blocks.
function fastHighlight(previous, next) {
  const oldElement = areaSentence(previous);
  const newElement = areaSentence(next);

  if (oldElement) {
    oldElement.classList.remove('active');
  }

  if (newElement) {
    newElement.classList.add('active');
  }

  // Update the progress indicators.
  const pct = Math.min(
    100,
    Math.round((next + 1) / sentences.length * 100)
  );

  $('bookPct').textContent = pct + '%';
  $('bookBar').style.width = pct + '%';

  // Save progress without rebuilding the book.
  savePosition();

  // Scroll immediately, without a slow animation.
  scrollToActive('auto');
}

// Replace the original navigation function.
move = function(delta) {
  if (mode !== 'reading' || !sentences.length) return;

  const previous = position;
  const next = Math.max(
    0,
    Math.min(sentences.length - 1, position + delta)
  );

  if (previous === next) return;

  position = next;
  fastHighlight(previous, next);
};


/* V6: Supabase cloud sync. Offline-first: the local IndexedDB library is authoritative
   while offline; remote sync uses user-scoped RLS and a private Storage bucket. */
const CLOUD_URL='https://pvrrghyjuwxvqvfcyxvj.supabase.co';
const CLOUD_KEY='sb_publishable_RkwTYLGeo2f9-EkfRFKFjw_YMjMF5dt';
const CLOUD_BUCKET='reader-pdf';
const cloudSessionKey='focus-reader-cloud-session';
let cloudSession=null,cloudBusy=false,cloudTimer=null,cloudRefreshing=null;
function cloudMessage(message){$('cloudStatus').textContent=message}
function cloudHeaders(token=cloudSession?.access_token){return {'apikey':CLOUD_KEY,...(token?{'Authorization':'Bearer '+token}:{})}}
function cloudSessionSave(session){cloudSession=session;localStorage.setItem(cloudSessionKey,JSON.stringify(session));cloudDisplay()}
function cloudDisplay(){const signed=!!cloudSession?.access_token;$('cloudSignIn').hidden=signed;$('cloudSignedIn').hidden=!signed;$('cloudAccount').textContent=signed?(cloudSession.user?.email||'Signed in'):''}
async function cloudRequest(path,{method='GET',body,headers={},raw=false,retry=true}={}){
  if(!navigator.onLine)throw Error('Offline');
  const reqHeaders={...cloudHeaders(),...headers};
  const response=await fetch(CLOUD_URL+path,{method,headers:reqHeaders,body:body===undefined?undefined:(body instanceof Blob||body instanceof ArrayBuffer||body instanceof Uint8Array?body:JSON.stringify(body))});
  if(response.status===401&&retry&&cloudSession?.refresh_token){await cloudRefresh();return cloudRequest(path,{method,body,headers,raw,retry:false})}
  if(!response.ok){const detail=await response.text();throw Error(response.status+' '+detail.slice(0,180))}
  if(raw)return response;
  if(response.status===204||response.headers.get('content-length')==='0')return null;
  return response.json();
}
async function cloudRefresh(){
  if(cloudRefreshing)return cloudRefreshing;
  cloudRefreshing=(async()=>{
    const refresh=cloudSession?.refresh_token;if(!refresh)throw Error('Session expired');
    const r=await fetch(CLOUD_URL+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{'apikey':CLOUD_KEY,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:refresh})});
    if(!r.ok)throw Error('Session expired; sign in again');
    cloudSessionSave(await r.json());
  })();try{return await cloudRefreshing}finally{cloudRefreshing=null}
}
async function cloudEnsureSession(){
  if(!cloudSession?.access_token)throw Error('Not signed in');
  if(cloudSession.expires_at&&Date.now()/1000>cloudSession.expires_at-90)await cloudRefresh();
}
function cloudPdfPath(id){return cloudSession.user.id+'/'+encodeURIComponent(id)+'.pdf'}
async function cloudUploadPdf(book){
  if(!book.pdfData)return;
  const data=new Blob([book.pdfData],{type:'application/pdf'});
  // The bucket's default 50 MB limit is enforced server-side.
  const path='/storage/v1/object/'+CLOUD_BUCKET+'/'+cloudPdfPath(book.id);
  // No upsert: existing objects are retained, avoiding the need for an UPDATE storage policy.
  try{await cloudRequest(path,{method:'POST',body:data,headers:{'Content-Type':'application/pdf','x-upsert':'false'},raw:true})}
  catch(e){if(!/409|already exists|Duplicate/i.test(e.message))throw e}
}
async function cloudDownloadPdf(id){
  const r=await cloudRequest('/storage/v1/object/authenticated/'+CLOUD_BUCKET+'/'+cloudPdfPath(id),{raw:true});
  return await r.blob();
}
async function cloudPushBook(book){
  await cloudUploadPdf(book);
  const record={user_id:cloudSession.user.id,book_id:book.id,title:book.title,reading_position:book.position||0,word_offset:book.wordOffset||0,glossary:book.glossary||{},updated_at:new Date(book.localUpdatedAt||Date.now()).toISOString()};
  await cloudRequest('/rest/v1/reader_books?on_conflict=user_id,book_id',{method:'POST',body:record,headers:{'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=minimal'},raw:true});
  book.syncDirty=false;book.cloudUpdatedAt=record.updated_at;await putBook(book);
}
async function cloudPullBook(row){
  let b=await getBook(row.book_id);
  if(!b){
    const blob=await cloudDownloadPdf(row.book_id);
    const file=new File([blob],row.title||'book.pdf',{type:'application/pdf'});
    await importPdf(file,{bookId:row.book_id,fromCloud:true,silent:true});
    b=await getBook(row.book_id);
    if(!b)throw Error('Could not extract downloaded PDF '+row.title);
  }
  if(b.syncDirty)return;
  if(b.cloudUpdatedAt&&Date.parse(b.cloudUpdatedAt)>=Date.parse(row.updated_at||0))return;
  b.position=row.reading_position||0;b.wordOffset=row.word_offset||0;b.glossary=row.glossary||{};
  b.cloudUpdatedAt=row.updated_at;b.syncDirty=false;await putBook(b);
  if(bookId===b.id){const word=b.wordOffset;glossary=b.glossary;rebuildSegments(word);scheduleRestoreScroll()}
}
async function cloudSync(){
  if(cloudBusy||!cloudSession||!navigator.onLine)return;
  cloudBusy=true;$('cloudSync').disabled=true;
  try{
    await cloudEnsureSession();cloudMessage('Syncing books…');
    const remote=await cloudRequest('/rest/v1/reader_books?select=*&order=updated_at.desc&limit=1000');
    const remoteById=new Map(remote.map(row=>[row.book_id,row]));
    const books=await allBooks();
    for(const b of books){
      const r=remoteById.get(b.id);
      if(!r||b.syncDirty){
        // Older local books without dirty metadata should not overwrite an existing cloud version.
        if(!r||b.syncDirty)await cloudPushBook(b);
      }else if(!b.cloudUpdatedAt||Date.parse(r.updated_at)>Date.parse(b.cloudUpdatedAt))await cloudPullBook(r);
    }
    for(const r of remote){if(!books.some(b=>b.id===r.book_id))await cloudPullBook(r)}
    const settings=await cloudRequest('/rest/v1/reader_settings?select=*&user_id=eq.'+encodeURIComponent(cloudSession.user.id)+'&limit=1');
    const dirty=localStorage.getItem('focus-reader-settings-dirty')==='1';
    if(dirty||!settings.length){
      await cloudRequest('/rest/v1/reader_settings?on_conflict=user_id',{method:'POST',body:{user_id:cloudSession.user.id,preferences:preferences(),updated_at:new Date().toISOString()},headers:{'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=minimal'},raw:true});
      localStorage.removeItem('focus-reader-settings-dirty');
    }else if(settings[0]?.preferences&&settings[0].updated_at!==localStorage.getItem('focus-reader-settings-cloud-date')){
      localStorage.setItem(prefsKey,JSON.stringify(settings[0].preferences));applyPreferences();
      if(sourceSentences.length){rebuildSegments(currentWordOffset());scheduleRestoreScroll()}
    }
    if(settings[0]?.updated_at)localStorage.setItem('focus-reader-settings-cloud-date',settings[0].updated_at);
    await refreshLibrary();cloudMessage('✓ Synced · '+new Date().toLocaleTimeString());
  }catch(e){cloudMessage('Sync paused: '+e.message);console.warn('Focus Reader sync:',e)}
  finally{cloudBusy=false;$('cloudSync').disabled=false}
}
function queueCloudSync(){if(!cloudSession||!navigator.onLine)return;clearTimeout(cloudTimer);cloudTimer=setTimeout(cloudSync,2500)}
$('cloudLogin').onclick=async()=>{
  const email=$('cloudEmail').value.trim(),password=$('cloudPassword').value;
  if(!email||!password){cloudMessage('Enter your email and password.');return}
  $('cloudLogin').disabled=true;cloudMessage('Signing in…');
  try{
    const r=await fetch(CLOUD_URL+'/auth/v1/token?grant_type=password',{method:'POST',headers:{'apikey':CLOUD_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const result=await r.json();if(!r.ok)throw Error(result.msg||result.error_description||result.message||'Sign in failed');
    cloudSessionSave(result);$('cloudPassword').value='';cloudMessage('Signed in. Starting sync…');await cloudSync();
  }catch(e){cloudMessage('Sign in failed: '+e.message)}finally{$('cloudLogin').disabled=false}
};
$('cloudSync').onclick=cloudSync;
$('cloudLogout').onclick=async()=>{
  const token=cloudSession?.access_token;cloudSession=null;localStorage.removeItem(cloudSessionKey);cloudDisplay();cloudMessage('Signed out. Local books remain available.');
  if(token&&navigator.onLine)fetch(CLOUD_URL+'/auth/v1/logout',{method:'POST',headers:{...cloudHeaders(token)}}).catch(()=>{});
};
window.addEventListener('online',()=>{cloudMessage('Online. Syncing…');queueCloudSync()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)queueCloudSync()});
setInterval(()=>{if(!document.hidden)cloudSync()},30000);
try{const saved=JSON.parse(localStorage.getItem(cloudSessionKey)||'null');if(saved?.access_token&&saved?.user?.id)cloudSession=saved}catch{}
cloudDisplay();if(cloudSession)queueCloudSync();
