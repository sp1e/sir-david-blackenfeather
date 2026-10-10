import { handleSirDavidRequest } from '../../../src/site/sir-david-api';
export const onRequest: PagesFunction<Parameters<typeof handleSirDavidRequest>[1]> = ({ request, env, params }) =>
  handleSirDavidRequest(request, env, ((params.route as string[]) ?? []).join('/'));
