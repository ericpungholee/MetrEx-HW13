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
