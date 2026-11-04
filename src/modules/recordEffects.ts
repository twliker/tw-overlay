/** DB commit 전에 화면·소리·타이머를 실행하지 않는다. 과거 배정의 순간 알림은 재생하지 않는다. */
let context:{effects:Array<() => void>;collecting:boolean;transient:boolean;observedAt:number} | null=null;
export const isCollectingRecordEffects=():boolean => !!context?.collecting;
export const transientEffectsAllowed=():boolean => !context || context.transient;
export const recordEventTime=():number => context?.observedAt ?? Date.now();
export function deferRecordEffect(effect:() => void):void {
  if (context?.collecting) context.effects.push(effect);else effect();
}
export function deferTransientEffect(effect:() => void):void {
  if (!context || context.transient) deferRecordEffect(effect);
}
export function collectRecordEffects(work:() => void,transient:boolean,observedAt=Date.now()):() => void {
  const previous=context,scope={effects:[] as Array<() => void>,collecting:true,transient,observedAt};
  context=scope;
  try {work();} finally {context=previous;}
  return () => {
    const outer=context;context={...scope,collecting:false};
    const failures:unknown[]=[];
    try {for (const effect of scope.effects) {try {effect();} catch (error) {failures.push(error);}}} finally {context=outer;}
    if (failures.length) throw new AggregateError(failures,'일부 화면 반영을 완료하지 못했습니다.');
  };
}
