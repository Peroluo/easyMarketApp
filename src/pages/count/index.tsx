import * as React from "react";
import HooksCount from "@/components/HooksCount";
import Count from "@/components/Count";
import styles from "@/pages/count/index.less";

export default () => {
  return (
    <div className={styles.page}>
      <HooksCount />
      <Count />
    </div>
  );
};
