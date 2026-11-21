import Image from "next/image";
import type { CatalogMarket } from "@metrex/exchange";

type Photo = CatalogMarket["photo"];

export function MarketPhoto({ photo, sizes, className }: { photo: Photo; sizes: string; className: string }) {
  return (
    <div className={`relative overflow-hidden bg-bg-soft ${className}`}>
      <Image src={photo.src} alt={photo.alt} sizes={sizes} fill loading="eager" className="object-cover object-[center_10%]" />
    </div>
  );
}

export function MarketPhotoCredit({ photo }: { photo: Photo }) {
  return (
    <span className="text-xs text-dim">
      Area photo · <a href={photo.creditUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{photo.credit}</a>
      <span className="sr-only"> (resized and cropped for display)</span>
    </span>
  );
}
