import { PortalError, requirePortalAdmin } from './portal-session.ts';
// Export stand-in for the host router's GET /api/calendar/events. The host also
// merges Proton ICS and routine-imported Outlook rows; this export reads the
// private calendar table only, so suggestions may see fewer busy periods.
const DATE=/^\d{4}-\d{2}-\d{2}$/;
export async function dispatchCalendar(context, request) {
  const url=new URL(request.url);
  if(request.method!=='GET'||url.pathname!=='/api/calendar/events')return Response.json({error:'Kalenderanropet är inte tillåtet.'},{status:403});
  try{await requirePortalAdmin(request,context.env);}
  catch(error){if(error instanceof PortalError)return Response.json({error:'Lås upp kalendern först.'},{status:error.status});throw error;}
  const from=url.searchParams.get('from')??'',to=url.searchParams.get('to')??'';
  if(!DATE.test(from)||!DATE.test(to))return Response.json({error:'Ogiltigt datumintervall.'},{status:400});
  const {results}=await context.env.DB.prepare(`SELECT id, title, event_date, all_day, start_time, end_time FROM private_calendar_events
    WHERE event_date >= ? AND event_date <= ? ORDER BY event_date, COALESCE(start_time, '99:99'), title`).bind(from,to).all();
  return Response.json({events:(results??[]).map(row=>({id:String(row.id),title:String(row.title),date:String(row.event_date),all_day:Number(row.all_day)===1,start_time:row.start_time??null,end_time:row.end_time??null}))});
}
