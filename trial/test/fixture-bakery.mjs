// fixture-bakery — the three-page bakery website the tests and the browser checks use, as
// trial/eval/probe-already.mjs builds it: a shared top bar with the page links and an order button,
// a hero, a grid of three bread cards, and a visit page with the address, phone number, an hours
// table and a map.

import { parse } from "../tree.mjs";

const BAR = (current) => `    row pad=3 fill=light justify=between align=center share=top
      text "Crumb" size=l bold
      row gap=4
        text "Home"${current === "Home" ? " bold" : " shade=mid"}
        text "Menu"${current === "Menu" ? " bold" : " shade=mid"}
        text "Visit us"${current === "Visit us" ? " bold" : " shade=mid"}
      button "Order now" primary`;

export const BAKERY = `app "Crumb Bakery" web
  screen "Home"
${BAR("Home")}
    col #homemain pad=5 gap=4
      shape #heroimg "Fresh loaves on the counter" h=320
      text #hero "Bread baked every morning at 5" size=xxl bold
      text #tag "Sourdough, pastries and coffee on Elm Street since 2009"
      row gap=2
        button #seemenu "See the menu" primary
        button #findus "Find us"
  screen "Menu"
${BAR("Menu")}
    col #main pad=5 gap=4
      text #menuh "Today's bread" size=xl bold
      grid #cards cols=3 gap=3
        col #c1 border pad=3 gap=2
          shape #p1 h=120
          text #n1 "Sourdough" size=l bold
          text #pr1 "$6.00"
          button #b1 "Add"
        col #c2 border pad=3 gap=2
          shape #p2 h=120
          text #n2 "Baguette" size=l bold
          text #pr2 "$3.50"
          button #b2 "Add"
        col #c3 border pad=3 gap=2
          shape #p3 h=120
          text #n3 "Croissant" size=l bold
          text #pr3 "$2.75"
          button #b3 "Add"
  screen "Visit us"
${BAR("Visit us")}
    row #visit pad=5 gap=5
      col #info gap=3 w=420
        text #visith "Visit us" size=xl bold
        col #addrbox gap=1
          text #addrl "Address" size=s shade=mid
          text #addr "412 Elm Street, Portland, OR"
        col #phonebox gap=1
          text #phonel "Phone" size=s shade=mid
          text #phone "(503) 555-0142"
        col #hoursbox gap=1
          text #hoursl "Hours" size=s shade=mid
          table #hours
            tr "Day | Open"
            tr "Mon – Fri | 7am – 3pm" data
            tr "Sat – Sun | 8am – 2pm" data
      shape #map "Map" grow h=360`;

export const bakery = parse(BAKERY).root;
