import styles from './EventTileArt.module.css'

export default function EventTileArt({ type }) {
  const isChance = type === 'chance';

  return (
    <>
      <div className={isChance ? styles.chanceBg : styles.fortuneBg} />
      <div className={isChance ? styles.chancePattern : styles.fortunePattern} />
      
      <div className={styles.artWrapper}>
        {isChance ? (
          <div className={styles.lotteryArt}>
             <div className={styles.ticket1} />
             <div className={styles.ticket2} />
          </div>
        ) : (
          <div className={styles.fortuneArt}>
             <div className={styles.tube} />
             <div className={styles.stick1} />
             <div className={styles.stick2} />
             <div className={styles.stick3} />
          </div>
        )}
      </div>
      
      <span className={styles.title}>{isChance ? 'CƠ HỘI' : 'KHÍ VẬN'}</span>
    </>
  )
}
