const en={
  language:'العربية',gallery:'← Margo Web Demos',heading:'The Game Menu',canvas:'Deep-sea survey submersible and game controls',
  title:['Lantern','Descent'],tag:'Tethered ocean survey',summary:'Three stations. One tether back to the surface.',
  launch:'Launch dive',settings:'Settings',help:'Controls',paused:'Dive paused',resume:'Resume dive',end:'End dive…',
  back:'Back',cancel:'Cancel',close:'Close',helpTitle:'Operating the dive',
  helpText:'Tap or click controls. Use Tab or arrows and Enter on a keyboard. On a gamepad, move with the D-pad or left stick, accept with A and go back with B. Pick up a kit item and use it by activating it again, or move it to another slot.',
  endTitle:'End this dive?',endText:'The station log and equipment changes from this dive will be cleared.',endYes:'End dive',stay:'Keep diving',
  contrast:'High contrast',motion:'Reduce motion',typeSize:'Text size',languageTitle:'Language',
  kit:'Equipment',kitIntro:'Activate twice to use a kit item, or drag to move it.',
  pause:'Pause',survey:'Survey site',descend:'Next station',log:'Dive log',logTitle:'Recorded stations',
  charge:'Battery',records:'Samples',record:'Record sample',siteLogged:'Sample recorded.',
  surveyCost:'Recording uses 18% battery.',review:'Site already surveyed.',needCharge:'Use an available power cell to continue.',
  done:'Dive complete. All three samples are in the log.',finish:'Surface',finished:'Survey complete',
  moved:'Equipment moved.',full:'The battery is already full.',recharge:'Power cell replaced. Battery restored by up to 28%.',
  held:'Picked up',stations:['Shelf edge','Basalt ridge','Vent field'],
  detail:['Mineral grains on the outer shelf.','A basalt glass fragment from the ridge.','A sample of white vent precipitate.'],
  item:{
    cell:['Power cell','Adds up to 28% battery. Use one at a time.','⊕'],
    log:['Field notebook','Index of recorded samples.','≡'],
    shelf:['Shelf grain','Sample from 40 metres depth.','◇'],
    ridge:['Basalt glass','Sample from 230 metres depth.','◆'],
    vent:['Vent precipitate','Sample from 440 metres depth.','✦']
  }
};
const ar={
  language:'English',gallery:'عروض مارغو على الويب ←',heading:'قائمة اللعبة',canvas:'غوّاصة للمسح في أعماق البحر وأدوات التحكّم في اللعبة',
  title:['هبوط','الفانوس'],tag:'مسح المحيط بغوّاصة مربوطة',summary:'ثلاث محطات. حبل واحد للعودة إلى السطح.',
  launch:'ابدأ الغوص',settings:'الإعدادات',help:'أدوات التحكّم',paused:'توقّف الغوص',resume:'استأنف الغوص',end:'أنهِ الغوص…',
  back:'رجوع',cancel:'إلغاء',close:'إغلاق',helpTitle:'التحكّم في الغوص',
  helpText:'المس الأزرار أو انقر عليها. استخدم مفتاح الجدولة أو الأسهم ثم الإدخال. على يد التحكّم، استخدم الأسهم أو العصا اليسرى، والزر إيه للاختيار والزر بي للرجوع. اختر أداة مرتين لاستخدامها، أو انقلها إلى خانة أخرى.',
  endTitle:'هل تريد إنهاء الغوص؟',endText:'سيُمسح سجلّ المحطات وتعديلات المعدات لهذه الرحلة.',endYes:'أنهِ الغوص',stay:'تابع الغوص',
  contrast:'تباين عالٍ',motion:'تقليل الحركة',typeSize:'حجم النص',languageTitle:'اللغة',
  kit:'المعدات',kitIntro:'اختر الأداة مرتين لاستخدامها، أو اسحبها لنقلها.',
  pause:'توقّف',survey:'امسح الموقع',descend:'المحطة التالية',log:'سجلّ الغوص',logTitle:'المحطات المسجّلة',
  charge:'البطارية',records:'العينات',record:'سجّل العينة',siteLogged:'سُجّلت العينة.',
  surveyCost:'يستهلك تسجيل العينة ١٨٪ من البطارية.',review:'سبق مسح هذا الموقع.',needCharge:'استخدم خلية طاقة للمتابعة.',
  done:'اكتمل الغوص. العينات الثلاث في السجلّ.',finish:'اصعد إلى السطح',finished:'اكتمل المسح',
  moved:'نُقلت المعدات.',full:'البطارية ممتلئة.',recharge:'أُضيفت طاقة تصل إلى ٢٨٪.',
  held:'حُملت الأداة',stations:['حافة الجرف','عرف البازلت','حقل الفوّهات'],
  detail:['حبيبات معدنية من حافة الجرف.','شظية زجاج بازلتي من العرف.','عينة بيضاء من ترسّبات الفوّهات.'],
  item:{
    cell:['خلية طاقة','تضيف حتى ٢٨٪ من الشحن. استخدم خلية واحدة في كل مرة.','⊕'],
    log:['دفتر المسح','فهرس العينات المسجّلة.','≡'],
    shelf:['حبيبات الجرف','عينة من عمق ٤٠ متراً.','◇'],
    ridge:['زجاج بازلتي','عينة من عمق ٢٣٠ متراً.','◆'],
    vent:['ترسّبات الفوّهات','عينة من عمق ٤٤٠ متراً.','✦']
  }
};
export const language={en,ar};
export const zones=[
  {depth:40,sample:'shelf',sky:'#17434b'},
  {depth:230,sample:'ridge',sky:'#112f3b'},
  {depth:440,sample:'vent',sky:'#0b2531'}
];
