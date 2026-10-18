import {migrateProgressResponse} from "../../../../lib/fees/api.mjs";
export async function POST(request:Request) {
  return migrateProgressResponse(request,{
    secret:process.env.SCAN_CURSOR_SECRET||undefined,
  });
}
export function GET(){return new Response(null,{status:405,headers:{Allow:"POST","Cache-Control":"no-store"}});}
