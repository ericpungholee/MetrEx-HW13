# Market photo credits

These area photos show real homes from the four regions. They are used as illustrations on market cards and detail pages. The local WebP copies have been resized, and the interface crops them to fit.

| Asset | Photograph and source | Photographer | License |
|---|---|---|---|
| `wildfire-house.webp` | [Pacific Palisades House View 1](https://commons.wikimedia.org/wiki/File:Pacific_Palisades_House_View_1.jpg) | Capriatti | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `hurricane-house.webp` | [Coral Gables 1925 House](https://commons.wikimedia.org/wiki/File:Coral_Gables_1925_House.jpg) | Escuadro | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `earthquake-house.webp` | [Churchill Manor, Napa](https://commons.wikimedia.org/wiki/File:Churchill_Manor,_485_Brown_St.,_Napa,_CA_9-5-2010_4-41-04_PM.JPG) | Sanfranman59 | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| `tornado-house.webp` | [Jordan House, West Des Moines](https://commons.wikimedia.org/wiki/File:Jordan_House_street_view.JPG) | Goddesshanna | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |

## Listing house images

`app/public/markets/listing-houses/` contains seven fictional house exteriors generated with the built-in ImageGen tool. The prompts ask for photorealistic exterior views in daylight, with architecture and landscaping inspired by Pacific Palisades, Coral Gables, Napa and central Iowa. Each listing in `packages/exchange/src/catalog.ts` references its own WebP asset. The app test checks that no two properties use the same path or image bytes.
