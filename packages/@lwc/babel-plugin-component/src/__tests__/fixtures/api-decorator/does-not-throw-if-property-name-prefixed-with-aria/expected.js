import { registerDecorators as _registerDecorators, LightningElement, registerComponent as _registerComponent } from "lwc";
import _tmpl from "./test.html";
class Test extends LightningElement {
  ariaDescribedBy;
  /*LWC compiler vX.X.X*/
}
_registerDecorators(Test, {
  publicProps: {
    ariaDescribedBy: {
      config: 0
    }
  }
});
export default _registerComponent(Test, {
  tmpl: _tmpl,
  sel: "lwc-test",
  apiVersion: 9999999
});