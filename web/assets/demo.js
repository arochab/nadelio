'use strict';
// Deterministic, synthetic fixtures. This page makes no network/API requests.
const brands = ['Orbe Studio', 'Rivage Cloud'];
const questions = [
  ['Which tool helps a small agency manage projects?', 'Quel outil aide une petite agence à gérer ses projets ?', 'project management', 'gestion de projet'],
  ['What works for teams collaborating remotely?', 'Quel outil convient aux équipes à distance ?', 'remote collaboration', 'collaboration à distance'],
  ['Which tool makes team workloads easier to plan?', 'Quel outil facilite la planification des équipes ?', 'workload planning', 'planification des équipes'],
  ['What helps track budgets across client projects?', 'Quel outil permet de suivre les budgets des projets clients ?', 'project budgets', 'budgets de projet'],
  ['Which tool offers a simple start for a small team?', 'Quel outil est simple à prendre en main pour une petite équipe ?', 'onboarding', 'prise en main'],
  ['What connects project work with existing tools?', 'Quel outil relie les projets aux outils existants ?', 'integrations', 'intégrations'],
  ['How can an agency collect client approvals?', 'Comment une agence peut-elle recueillir les validations clients ?', 'client approvals', 'validations clients'],
  ['Which tool helps clients follow project progress?', 'Quel outil aide les clients à suivre leurs projets ?', 'client reporting', 'suivi client']
];
// Each array is the question indices where a brand appears in one response pass.
const orbe = [[0,1,2,3,4,5],[0,1,2,3,4,7],[0,1,2,3,4,5,7],[0,1,2,4,5,7],[0,1,2,3,4,5,7]];
const fixtures = {
  clear: [orbe, [[1,3,6,7],[0,3,6,7],[2,6,7],[1,2,5,6],[0,4,6]]],
  overlap: [orbe, [[0,1,3,6,7],[0,1,2,3,6,7],[1,2,4,6,7],[0,1,2,3,4,6,7],[0,2,3,4,6,7]]],
  missing: [[orbe[0]], [[1,3,6,7]]]
};
const copy = {
en: {
 skip:'Skip to comparison', example:'Product example', audit:'Audit your brand ↗', eyebrow:'From an answer to a decision',
 title:'Where does your brand enter the conversation?', lead:'Compare two brands across buyer questions. Open an answer, check what supports the result, then decide what to investigate.',
 notice:'Fictional example. The brands and responses are invented. No live search, AI request or payment runs here.',
 step1:'01 / Compare', comparison:'AI mention coverage', scenarioLabel:'Example', focusLabel:'Focus brand',
 options:['A clear difference','A close comparison','Insufficient observations'], methodLink:'How is this calculated?',
 questions:'Which questions reveal a gap?', gaps:'Only focus-brand gaps', tableHint:'Select a question to inspect its responses. A fraction counts mentions, not recommendations.',
 caption:'AI mentions across repeated fictional responses', question:'Buyer question', step2:'02 / Inspect the evidence', response:'Response', synthetic:'Simulated',
 raw:'Observation details', evidenceNote:'This is synthetic source material. A real audit must link its conclusion to the collected answers and the measured model.',
 step3:'03 / Choose the next step', nextLimit:'An absent mention does not explain its cause. Validate the pattern before changing your site.',
 brief:'Download review brief', live:'Run a real audit ↗', methodTitle:'Read the method and its limits', credit:'Built by Adam Chabbi.', source:'Explore the source code ↗',
 clear:['Orbe appears more often in this example.','Its lowest coverage across the five passes stays above Rivage’s highest. This describes these sample answers, not the wider market.'],
 overlap:['The observed ranges overlap.','One average is higher, but coverage varies across passes. This sample alone does not support a stable ranking.'],
 missing:['One pass cannot show variation.','You can inspect individual answers, but there are too few repeated observations to display a range or a reliable comparison.'],
 noRange:'Range unavailable: only one pass.', range:'Mark: average. Band: lowest to highest coverage across passes. Scale: 0–100%.',
 mentioned:'Mentioned', absent:'Not mentioned', engine:'Assistant', engineValue:'Synthetic fixture, no model called', evidenceId:'Observation ID', selection:'Question set', selectionValue:'8 agency software questions, illustrative selection', noGaps:'No gaps match this filter.',
 answerIntro:'For this need, consider ', answerTail:'. Compare permissions, the actual workflow and pricing before making a choice.',
 neither:'Start by defining the workflow, access permissions and expected handoffs. This response does not name a particular product.',
 actionGap:'Investigate ', actionPresent:'Check whether this strength holds.',
 gapDetail:' is missing from some answers about this topic. Check whether its website explains the relevant capability, then test the same question with a real audit. This sample cannot diagnose a content problem.',
 presentDetail:' appears in every sample answer to this question. Review the exact wording and validate it on real observations before using it as a positioning claim.',
 actionMissing:'Collect repeated answers first.', missingDetail:'Keep the question and brand fixed, repeat the observation, and inspect the responses. Do not prioritize website changes from one answer.',
 downloaded:'Review brief downloaded.', briefTitle:'Nadelio | Review brief', questionLabel:'Selected question', focus:'Focus brand', sample:'Fictional example; no real brand or model was measured.',
 method:'<h3>What the score measures</h3><p>Each pass contains one response to each of the eight questions. A brand earns one mention per response when its name appears. Multiple appearances in the same response count once.</p><p class="formula">Coverage per pass = questions mentioning the brand ÷ 8 × 100</p><p>The large number averages the passes. The band shows their minimum and maximum. It is an observed range, not a confidence interval, a market share estimate or a prediction of sales. A single pass has no range.</p><h3>What you can conclude</h3><p>These five fictional passes illustrate variability. The question set, model, location, time and response wording can all change a real result. Overlapping ranges do not establish equality; separate ranges do not prove market leadership.</p><h3>How this relates to the product</h3><p>This example isolates AI mention coverage so every score can be traced to a response. The full Nadelio audit also considers Google presence and AI ranking. This percentage is not its composite visibility score. The source code contains the real collection and reporting pipeline.</p>'
},
fr: {
 skip:'Aller à la comparaison', example:'Exemple du produit', audit:'Auditer votre marque ↗', eyebrow:'De la réponse à la décision',
 title:'Votre marque apparaît-elle dans la conversation ?', lead:'Comparez deux marques sur des questions d’achat. Ouvrez une réponse, vérifiez ce qui explique le résultat, puis choisissez le point à approfondir.',
 notice:'Exemple fictif. Les marques et les réponses sont inventées. Aucune recherche, requête IA ni aucun paiement ne sont lancés ici.',
 step1:'01 / Comparer', comparison:'Présence dans les réponses IA', scenarioLabel:'Exemple', focusLabel:'Marque étudiée',
 options:['Un écart net','Une comparaison serrée','Observations insuffisantes'], methodLink:'Comment ce chiffre est-il calculé ?',
 questions:'Quelles questions révèlent un manque ?', gaps:'Seulement les absences', tableHint:'Sélectionnez une question pour lire ses réponses. Les fractions comptent des mentions, pas des recommandations.',
 caption:'Mentions dans les réponses fictives répétées', question:'Question d’achat', step2:'02 / Examiner les preuves', response:'Réponse', synthetic:'Simulée',
 raw:'Détail de l’observation', evidenceNote:'Ce contenu source est fictif. Un audit réel doit relier sa conclusion aux réponses recueillies et au modèle interrogé.',
 step3:'03 / Choisir la suite', nextLimit:'Une absence ne révèle pas sa cause. Validez le constat avant de modifier votre site.',
 brief:'Télécharger la fiche de travail', live:'Lancer un audit réel ↗', methodTitle:'Lire la méthode et ses limites', credit:'Conçu et développé par Adam Chabbi.', source:'Consulter le code source ↗',
 clear:['Orbe apparaît plus souvent dans cet exemple.','Sa présence la plus faible sur les cinq passages reste supérieure au maximum de Rivage. Ce constat décrit ces réponses fictives, pas le marché.'],
 overlap:['Les plages observées se chevauchent.','Une moyenne est plus haute, mais la présence varie entre les passages. Cet exemple ne suffit pas à établir un classement stable.'],
 missing:['Un passage ne montre pas la variabilité.','Les réponses restent consultables, mais il manque des observations répétées pour afficher une plage ou une comparaison fiable.'],
 noRange:'Plage indisponible : un seul passage.', range:'Repère : moyenne. Bande : minimum et maximum entre les passages. Échelle : 0–100 %.',
 mentioned:'Mentionnée', absent:'Non mentionnée', engine:'Assistant', engineValue:'Exemple fictif, aucun modèle appelé', evidenceId:'Identifiant', selection:'Questions', selectionValue:'8 questions sur les logiciels pour agences, sélection illustrative', noGaps:'Aucune absence ne correspond à ce filtre.',
 answerIntro:'Pour ce besoin, vous pouvez envisager ', answerTail:'. Comparez les droits d’accès, le fonctionnement concret et les tarifs avant de choisir.',
 neither:'Commencez par préciser le processus, les droits d’accès et les étapes de validation. Cette réponse ne nomme aucun produit.',
 actionGap:'Examiner : ', actionPresent:'Vérifier si ce point fort se confirme.',
 gapDetail:' est absente de certaines réponses sur ce sujet. Vérifiez si son site explique la fonction concernée, puis testez cette question dans un audit réel. Cet exemple ne permet pas de diagnostiquer un problème de contenu.',
 presentDetail:' apparaît dans chaque réponse fictive à cette question. Relisez les formulations exactes et vérifiez-les sur des observations réelles avant d’en faire un argument commercial.',
 actionMissing:'Recueillir des réponses répétées.', missingDetail:'Conservez la même question et la même marque, répétez l’observation et relisez les réponses. Ne décidez pas de modifier le site à partir d’une seule réponse.',
 downloaded:'Fiche de travail téléchargée.', briefTitle:'Nadelio | Fiche de travail', questionLabel:'Question sélectionnée', focus:'Marque étudiée', sample:'Exemple fictif ; aucune marque réelle ni aucun modèle n’ont été mesurés.',
 method:'<h3>Ce que mesure le score</h3><p>Chaque passage contient une réponse à chacune des huit questions. Une marque compte pour une mention lorsque son nom apparaît dans la réponse. Plusieurs apparitions dans une réponse ne comptent qu’une fois.</p><p class="formula">Présence par passage = questions mentionnant la marque ÷ 8 × 100</p><p>Le grand chiffre est la moyenne des passages. La bande indique leur minimum et leur maximum. Il s’agit d’une plage observée, pas d’un intervalle de confiance, d’une part de marché ni d’une prévision de ventes. Un passage unique ne donne pas de plage.</p><h3>Ce que vous pouvez en conclure</h3><p>Ces cinq passages fictifs illustrent la variabilité. Les questions, le modèle, le lieu, la date et les formulations peuvent tous modifier un résultat réel. Des plages qui se chevauchent ne prouvent pas une égalité ; des plages séparées ne prouvent pas une position de leader.</p><h3>Le lien avec le produit</h3><p>Cet exemple isole la présence dans les réponses IA pour rendre chaque score vérifiable. L’audit complet de Nadelio considère aussi la présence sur Google et le classement dans les réponses IA. Ce pourcentage n’est pas son score composite de visibilité. Le code source contient le véritable moteur de collecte et de rapport.</p>'
}};
const $ = id => document.getElementById(id);
let lang = new URLSearchParams(location.search).get('lang') === 'fr' ? 'fr' : 'en';
let selected = 6;
let run = 0;
const f = () => lang === 'fr' ? 1 : 0;
const data = () => fixtures[$('scenario').value];
const count = (b,q) => data()[b].filter(pass => pass.includes(q)).length;
const fmt = n => new Intl.NumberFormat(lang, {maximumFractionDigits:1}).format(n);
const stats = b => {const v=data()[b].map(pass=>pass.length/8*100);return {mean:v.reduce((a,n)=>a+n,0)/v.length,low:Math.min(...v),high:Math.max(...v)};};
function render() {
 const t=copy[lang], key=$('scenario').value, n=data()[0].length;
 document.documentElement.lang=lang;
 document.title=lang==='fr'?'Nadelio | Explorer une comparaison':'Nadelio | Explore a comparison';
 document.querySelectorAll('[data-copy]').forEach(node=>node.textContent=t[node.dataset.copy]);
 document.querySelectorAll('.audit-link').forEach(a=>a.href='/?lang='+lang);
 $('lang').textContent=lang==='en'?'Français':'English';
 [...$('scenario').options].forEach((option,i)=>option.textContent=t.options[i]);
 $('sample-size').textContent=lang==='fr'?('8 questions · '+n+' passage'+(n>1?'s':'')+' fictif'+(n>1?'s':'')):('8 questions · '+n+' fictional pass'+(n>1?'es':''));
 $('verdict').textContent=t[key][0]; $('verdict-detail').textContent=t[key][1];
 $('scores').setAttribute('aria-label',t.comparison);
 $('scores').innerHTML=brands.map((brand,b)=>{const s=stats(b);return '<div class="score-row '+(b?'rival':'')+'"><div class="score-label"><span>'+brand+'</span><strong>'+fmt(s.mean)+'<small> %</small></strong></div>'+(n<2?'<p class="no-range">'+t.noRange+'</p>':'<div class="track" role="img" aria-label="'+brand+': '+fmt(s.low)+'–'+fmt(s.high)+' %"><span class="interval" style="left:'+s.low+'%;width:'+(s.high-s.low)+'%"></span><span class="point" style="left:'+s.mean+'%"></span></div>')+'</div>';}).join('')+(n>1?'<p class="range-note">'+t.range+'</p>':'');
 const visible=questions.map((q,i)=>i).filter(i=>!$('gaps').checked||count($('focus').selectedIndex,i)<n);
 if(!visible.includes(selected)&&visible.length)selected=visible[0];
 $('question-rows').innerHTML=visible.map(i=>'<tr class="'+(i===selected?'selected':'')+'"><td><button type="button" data-question="'+i+'" aria-pressed="'+(i===selected)+'">'+questions[i][f()]+'</button></td>'+brands.map((b,j)=>'<td class="'+(count(j,i)<n?'count-low':'count-high')+'">'+count(j,i)+' / '+n+'</td>').join('')+'</tr>').join('');
 $('empty').hidden=!!visible.length; $('empty').textContent=t.noGaps;
 $('run').innerHTML=Array.from({length:n},(_,i)=>'<option value="'+i+'">'+(i+1)+' / '+n+'</option>').join('');
 if(run>=n)run=0; $('run').value=run;
 $('method-content').innerHTML=t.method;
 $('brief-status').textContent='';
 renderEvidence();
}
function renderEvidence() {
 const t=copy[lang], n=data()[0].length, focus=$('focus').selectedIndex;
 const present=brands.filter((b,i)=>data()[i][run].includes(selected));
 $('evidence-heading').textContent=questions[selected][f()];
 const join=lang==='fr'?' et ':' and ';
 $('answer').textContent=present.length?t.answerIntro+present.join(join)+t.answerTail:t.neither;
 $('mentions').innerHTML=brands.map((brand,i)=>'<span class="mention"><b>'+brand+'</b><span>'+(data()[i][run].includes(selected)?t.mentioned:t.absent)+'</span></span>').join('');
 const observationId=$('scenario').value+'-q'+(selected+1)+'-r'+(run+1);
 $('observation').innerHTML='<dt>'+t.evidenceId+'</dt><dd>'+observationId+'</dd><dt>'+t.engine+'</dt><dd>'+t.engineValue+'</dd><dt>'+t.selection+'</dt><dd>'+t.selectionValue+'</dd>';
 const absent=count(focus,selected)<n;
 $('next-heading').textContent=n<2?t.actionMissing:absent?t.actionGap+questions[selected][2+f()]+'.':t.actionPresent;
 $('next-detail').textContent=n<2?t.missingDetail:brands[focus]+(absent?t.gapDetail:t.presentDetail);
}
$('scenario').addEventListener('change',()=>{run=0;render();});
$('focus').addEventListener('change',render);
$('gaps').addEventListener('change',render);
$('run').addEventListener('change',()=>{run=Number($('run').value);renderEvidence();});
$('lang').addEventListener('click',()=>{lang=lang==='en'?'fr':'en';const url=new URL(location.href);url.searchParams.set('lang',lang);history.replaceState(null,'',url);render();});
$('question-rows').addEventListener('click',event=>{
 const button=event.target.closest('[data-question]');if(!button)return;
 selected=Number(button.dataset.question);
 // Keep the actual focused button in the DOM when selecting another question.
 document.querySelectorAll('[data-question]').forEach(b=>{const active=Number(b.dataset.question)===selected;b.setAttribute('aria-pressed',String(active));b.closest('tr').classList.toggle('selected',active);});
 renderEvidence();
 if(matchMedia('(max-width:740px)').matches){$('evidence-heading').tabIndex=-1;$('evidence-heading').focus({preventScroll:true});$('evidence-heading').scrollIntoView({block:'start'});}
});
$('method-link').addEventListener('click',()=>{$('method').open=true;});
$('brief').addEventListener('click',()=>{
 const t=copy[lang];
 const lines=[t.briefTitle,t.sample,'',t.scenarioLabel+': '+t.options[$('scenario').selectedIndex],t.focus+': '+brands[$('focus').selectedIndex],t.questionLabel+': '+questions[selected][f()],t.response+': '+(run+1)+' / '+data()[0].length,'',$('answer').textContent,'',...brands.map((b,i)=>b+': '+count(i,selected)+' / '+data()[0].length+' (mentions)'),'',$('next-heading').textContent,$('next-detail').textContent,t.nextLimit,'',data()[0].length>1?t.range:t.noRange,'https://www.nadelio.com/demo.html?lang='+lang];
 const url=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/plain;charset=utf-8'}));
 const a=document.createElement('a');a.href=url;a.download='nadelio-'+(lang==='fr'?'fiche-exemple':'sample-review')+'.txt';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);$('brief-status').textContent=t.downloaded;
});
render();
