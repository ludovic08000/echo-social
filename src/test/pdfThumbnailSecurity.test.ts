// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const {getDocument}=vi.hoisted(()=>({getDocument:vi.fn()}));
vi.mock('pdfjs-dist',()=>({getDocument,GlobalWorkerOptions:{workerSrc:''}}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url',()=>({default:'/assets/same-package-worker.mjs'}));
import {generatePdfThumbnail} from '@/lib/messaging/pdfThumbnail';
beforeEach(()=>{vi.clearAllMocks()});
afterEach(()=>{vi.unstubAllGlobals()});
it('renders only a thumbnail with bounded images and destroys the document worker',async()=>{
  const destroy=vi.fn().mockResolvedValue(undefined);
  const render=vi.fn().mockReturnValue({promise:Promise.resolve()});
  getDocument.mockReturnValue({destroy,promise:Promise.resolve({getPage:async()=>({getViewport:({scale}:{scale:number})=>({width:800*scale,height:1000*scale}),render})})});
  const canvas={width:0,height:0,getContext:()=>({}),toBlob:(callback:(blob:Blob)=>void)=>callback(new Blob(['thumbnail'],{type:'image/jpeg'}))};
  vi.stubGlobal('document',{createElement:()=>canvas});
  expect(await generatePdfThumbnail(new File(['synthetic pdf'],'sample.pdf',{type:'application/pdf'}))).toBeInstanceOf(Blob);
  expect(getDocument.mock.calls[0][0]).toMatchObject({enableXfa:false,stopAtErrors:true,maxImageSize:16_777_216});
  expect(canvas.width).toBe(240);expect(render).toHaveBeenCalledOnce();expect(destroy).toHaveBeenCalledOnce();
});
it('closes failed parsers and never prevents sending the original attachment',async()=>{
  const destroy=vi.fn().mockResolvedValue(undefined);
  getDocument.mockImplementation(()=>({destroy,promise:Promise.reject(new Error('invalid pdf'))}));
  expect(await generatePdfThumbnail(new File(['invalid'],'sample.pdf'))).toBeNull();
  expect(destroy).toHaveBeenCalledOnce();
});
