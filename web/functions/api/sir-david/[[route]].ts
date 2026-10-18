import { handleSirDavidRequest } from '../../../src/site/sir-david-api';
import { dispatchCalendar } from '../../../src/site/sir-david-calendar-dispatch.js';
export const onRequest: PagesFunction<Parameters<typeof handleSirDavidRequest>[1]> = ctx =>
  handleSirDavidRequest(ctx.request,ctx.env,((ctx.params.route as string[])??[]).join('/'),async request=>{
    return dispatchCalendar(ctx,request);
  });
